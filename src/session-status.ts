import type { Store } from './store.ts';
import type { UsageTracker } from './usage-tracker.ts';
import type { ContextView } from './usage.ts';

/** What the status sink needs of a session view. */
type View = { id: string; account: string; context?: ContextView };

const SAVE_EVERY = 10_000;
const EMIT_EVERY = 1000;

/** The part of a context the UI shows. */
const shownOf = (c: ContextView): string => `${c.pct}|${Math.round(c.tokens / 1000)}|${c.cache?.warm}|${c.cache?.expiresAt}|${c.stale}`;

/**
 * Status line updates for live sessions: context on the view, saved every 10 s, the UI told at most once a
 * second (the last change is never dropped), usage handed to the tracker.
 */
export function createStatusSink(o: { store: Store; tracker: UsageTracker; view: (id: string) => View | undefined; emit: (id: string) => void }) {
  const saved = new Map<string, number>();
  const emitted = new Map<string, { shown: string; at: number; timer?: ReturnType<typeof setTimeout> }>();

  return {
    ingest(view: View, body: unknown): void {
      const ctx = o.tracker.ingest(view.id, view.account, body, view.context);
      view.context = ctx;
      if (ctx.at - (saved.get(view.id) ?? 0) >= SAVE_EVERY) {
        saved.set(view.id, ctx.at);
        o.store.updateSession(view.id, { context: JSON.stringify(ctx) });
      }
      const due = emitted.get(view.id) ?? { shown: '', at: 0 };
      if (shownOf(ctx) === due.shown) return;
      clearTimeout(due.timer);
      const flush = (): void => {
        const v = o.view(view.id);
        if (!v?.context) return;
        emitted.set(view.id, { shown: shownOf(v.context), at: Date.now() });
        o.emit(view.id);
      };
      if (ctx.at - due.at >= EMIT_EVERY) flush();
      else {
        const timer = setTimeout(flush, EMIT_EVERY - (ctx.at - due.at));
        timer.unref();
        emitted.set(view.id, { ...due, timer });
      }
    },
    /** A session ended, was archived or resumed: drop its samples and timers. */
    forget(id: string): void {
      o.tracker.forget(id);
      saved.delete(id);
      clearTimeout(emitted.get(id)?.timer);
      emitted.delete(id);
    },
    /** Save every live context (shutdown). */
    close(views: Iterable<View>): void {
      for (const e of emitted.values()) clearTimeout(e.timer);
      for (const v of views) if (v.context) o.store.updateSession(v.id, { context: JSON.stringify(v.context) });
    },
  };
}
