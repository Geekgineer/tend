import type { TendEvent } from './events.ts';
import type { SessionState } from './state.ts';
import type { Intent } from './attention.ts';
import { createStuckWatch } from './stuck.ts';
import type { Stuck } from './stuck.ts';

// Problem flags on a session (spec §9–§10): stuck and crashed. Both are urgent notifications.

type View = { id: string; name: string; state: SessionState; paused: boolean; stuck?: Stuck; crashed?: true };

export function createFlags(o: { notify: (i: Intent) => void; emit: (v: View) => void; now?: () => number }) {
  const watch = createStuckWatch();
  const lastAt = new Map<string, number>();
  /** the latest hook kind per session: a running tool (PreToolUse) may take long without being stuck */
  const lastKind = new Map<string, string>();
  const startedAt = (o.now ?? Date.now)();
  /** Sessions Tend itself is stopping (pause, archive): their pane exit is not a crash. */
  const stopping = new Set<string>();

  const setStuck = (v: View, s: Stuck | null): boolean => {
    if (s === null) {
      if (!v.stuck) return false;
      delete v.stuck;
      return true;
    }
    const fresh = !v.stuck;
    v.stuck = s;
    if (fresh) {
      o.notify({
        sessionId: v.id,
        title: v.name,
        body: s.reason === 'silent' ? 'No progress for 10 minutes while working' : `Same ${s.tool} error ${s.count} times`,
        urgent: true,
        kind: 'stuck',
      });
    }
    return true;
  };

  return {
    stopping,
    /** After an event was applied. Returns true when a flag changed (the caller emits). */
    onEvent(v: View, prev: SessionState, ev: TendEvent): boolean {
      lastAt.set(v.id, ev.ts);
      lastKind.set(v.id, ev.kind);
      let changed = false;
      const s = watch.onEvent(v.id, ev.kind, ev.tool, ev.data, ev.ts);
      if (s !== undefined) changed = setStuck(v, s) || changed;
      if (ev.kind === 'resumed' && v.crashed) {
        delete v.crashed;
        changed = true;
      }
      // ended without the user asking: the pane died, or Claude ended for a reason that isn't /exit, /clear or
      // logout (real Claude reports SessionEnd "other" when its terminal is killed)
      const reason = (ev.data as { reason?: unknown } | null)?.reason;
      const userEnded = ev.kind === 'SessionEnd' && (reason === 'prompt_input_exit' || reason === 'clear' || reason === 'logout');
      const ended = ev.kind === 'pane_exit' || (ev.kind === 'SessionEnd' && !userEnded);
      if (ended && prev.status !== 'ended' && !v.paused && !stopping.has(v.id)) {
        v.crashed = true;
        o.notify({ sessionId: v.id, title: v.name, body: 'Session ended unexpectedly', urgent: true, kind: 'crash' });
        changed = true;
      }
      return changed;
    },
    /** Rebuild the crashed flag after a restart: ended by a pane exit with no SessionEnd before it. */
    replay(v: View, events: TendEvent[]): void {
      const last = events.findLast((e) => e.kind === 'pane_exit' || e.kind === 'SessionEnd' || e.kind === 'resumed');
      if (v.state.status === 'ended' && !v.paused && last?.kind === 'pane_exit') v.crashed = true;
      // the silence clock starts no earlier than this server (hooks sent while Tend was down are lost)
      if (events.length) {
        lastAt.set(v.id, Math.max(startedAt, events[events.length - 1]!.ts));
        lastKind.set(v.id, events[events.length - 1]!.kind);
      }
    },
    /** The last hook or progress seen for a session (ms). */
    lastActivity(id: string): number {
      return lastAt.get(id) ?? startedAt;
    },
    /** Claude's context grew (from its status line): that's progress. */
    alive(id: string, at: number): void {
      lastAt.set(id, at);
    },
    /** Every few seconds: working but silent for 10 min. */
    tick(views: Iterable<View>, now: number): void {
      for (const v of views) {
        if (v.stuck && v.stuck.reason !== 'silent') continue;
        const running = lastKind.get(v.id) === 'PreToolUse'; // a long build or test run is not stuck
        const s = watch.silent(v.state.status === 'working' && !running, lastAt.get(v.id) ?? startedAt, now);
        if (setStuck(v, s)) o.emit(v);
      }
    },
    forget(id: string): void {
      watch.forget(id);
      lastKind.delete(id);
      lastAt.delete(id);
    },
  };
}
