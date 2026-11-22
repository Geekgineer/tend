import type { TendEvent } from './events.ts';
import type { SessionState } from './state.ts';

// Hooks sent while Tend was down (a restart, a crash) are lost: Claude reports "connect ECONNREFUSED" and moves on,
// and Tend would show a stale state until the next hook. When a session's last activity is old enough, its screen
// settles it: a Claude dialog means it needs you; neither a dialog nor Claude's busy line (twice, 10 s apart)
// means it's idle. Sessions with a held card are left alone (the card is the truth), and so is the trust prompt.

type View = { id: string; state: SessionState; paused: boolean };

export const QUIET_MS = 20_000;
/** A Claude dialog is unambiguous: it counts sooner than "idle", which needs two readings. */
export const DIALOG_QUIET_MS = 5000;
const EVERY_MS = 10_000;
// Claude's busy line: "✻ Thinking… (12s · esc to interrupt)", "· Germinating… (1s · thinking)"; a finished turn
// reads "✻ Worked for 13s · done" (no ellipsis), so it isn't busy.
const BUSY = /esc to interrupt|^\s*[·✢✳✶✻✽*]\s+[^\n]*…\s*\(\d/im;
const DIALOG = /Do you want to proceed\?|Esc to cancel|Enter to confirm|^\s*❯\s*\d+\./m;

/** What Claude's screen says: a dialog, busy, or neither (its last 15 non-empty lines). */
export function readScreen(text: string): 'dialog' | 'busy' | 'idle' {
  const tail = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').filter((l) => l.trim()).slice(-15).join('\n');
  if (DIALOG.test(tail)) return 'dialog';
  if (BUSY.test(tail)) return 'busy';
  return 'idle';
}

export function createPaneSync(o: {
  views: () => Iterable<View>;
  snapshot: (id: string) => Buffer;
  hasCard: (id: string) => boolean;
  lastActivity: (id: string) => number;
  apply: (view: View, ev: TendEvent) => void;
  now: () => number;
}) {
  const checked = new Map<string, number>();
  const idleSeen = new Map<string, number>();
  return function sync(): void {
    const now = o.now();
    for (const v of o.views()) {
      const st = v.state.status;
      if (v.paused || (st !== 'working' && st !== 'needs_you') || v.state.need === 'trust' || o.hasCard(v.id)) {
        idleSeen.delete(v.id);
        continue;
      }
      const quiet = now - o.lastActivity(v.id);
      if (quiet < DIALOG_QUIET_MS || now - (checked.get(v.id) ?? 0) < (quiet < QUIET_MS ? 3000 : EVERY_MS)) continue;
      checked.set(v.id, now);
      let screen: 'dialog' | 'busy' | 'idle';
      try {
        screen = readScreen(o.snapshot(v.id).toString('utf8'));
      } catch {
        continue;
      }
      if (screen === 'dialog') {
        idleSeen.delete(v.id);
        if (st === 'working') o.apply(v, { ts: now, sessionId: v.id, kind: 'pane_dialog', data: null });
      } else if (screen === 'busy' || quiet < QUIET_MS) idleSeen.delete(v.id);
      else if ((idleSeen.get(v.id) ?? 0) + 1 >= 2) {
        idleSeen.delete(v.id);
        o.apply(v, { ts: now, sessionId: v.id, kind: 'pane_idle', data: null });
      } else idleSeen.set(v.id, (idleSeen.get(v.id) ?? 0) + 1);
    }
  };
}
