import { facts as gitFacts } from './git.ts';
import type { GitFacts } from './git.ts';
import { computeOverlaps, newPairs } from './overlap.ts';
import type { Overlap } from './overlap.ts';
import type { NotifyIntent } from './state.ts';

export const DEBOUNCE_MS = 300;
const MAX_FILES_IN_BODY = 3;

/** One session as the watcher sees it. Ineligible (paused) sessions have their facts cleared. */
export type WatchTarget = {
  id: string;
  name: string;
  dir: string;
  /** Worktree base commit; null for an in-place session. */
  base: string | null;
  /** Set for worktree sessions only: overlap is computed per common dir. */
  commonDir: string | null;
  eligible: boolean;
};

export type GitWatch = {
  refresh(opts?: { id?: string; silent?: boolean }): Promise<void>;
  /** Debounced refresh of one session (hook events). */
  schedule(id: string): void;
  close(): void;
};

export function createGitWatch(deps: {
  targets: () => WatchTarget[];
  set: (id: string, git: GitFacts | undefined, overlap: Overlap | undefined) => void;
  notify: (i: NotifyIntent) => void;
  facts?: typeof gitFacts;
}): GitWatch {
  const getFacts = deps.facts ?? gitFacts;
  const cache = new Map<string, GitFacts>();
  const timers = new Map<string, NodeJS.Timeout>();
  let prev = new Map<string, Overlap>();
  let tail: Promise<void> = Promise.resolve();
  let closed = false;

  const fetchOne = async (t: WatchTarget): Promise<void> => {
    try {
      cache.set(t.id, await getFacts(t.dir, t.base));
    } catch {
      // not a repo, or a transient failure (a lock, a busy disk): keep whatever facts we had
    }
  };

  const run = async (opts: { id?: string; silent?: boolean }): Promise<void> => {
    const before = deps.targets();
    const wanted = before.filter((t) => t.eligible && (opts.id === undefined || t.id === opts.id));
    await Promise.all(wanted.map(fetchOne));
    // sessions may have been paused or archived while git ran: decide from the current list
    const now = deps.targets();
    const live = now.filter((t) => t.eligible);
    for (const t of now) if (!t.eligible) cache.delete(t.id);
    const ids = new Set(now.map((t) => t.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id); // archived
    const items = live.flatMap((t) => {
      const g = cache.get(t.id);
      return t.commonDir !== null && g ? [{ id: t.id, commonDir: t.commonDir, changed: g.changed }] : [];
    });
    const next = computeOverlaps(items);
    for (const t of now) deps.set(t.id, t.eligible ? cache.get(t.id) : undefined, t.eligible ? next.get(t.id) : undefined);
    if (!opts.silent) {
      const name = (id: string): string => now.find((t) => t.id === id)?.name ?? id;
      for (const [a, b, files] of newPairs(prev, next)) {
        const shown = files.slice(0, MAX_FILES_IN_BODY).join(', ');
        const more = files.length > MAX_FILES_IN_BODY ? `, +${files.length - MAX_FILES_IN_BODY} more` : '';
        deps.notify({ sessionId: a, title: `${name(a)} overlaps ${name(b)}`, body: `Both changed: ${shown}${more}` });
      }
    }
    prev = next;
  };

  const refresh = (opts: { id?: string; silent?: boolean } = {}): Promise<void> => {
    const p = tail.then(() => run(opts));
    tail = p.catch(() => undefined);
    return p;
  };

  return {
    refresh,
    schedule(id) {
      if (closed) return;
      clearTimeout(timers.get(id));
      const t = setTimeout(() => {
        timers.delete(id);
        refresh({ id }).catch(() => undefined);
      }, DEBOUNCE_MS);
      t.unref();
      timers.set(id, t);
    },
    close() {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
