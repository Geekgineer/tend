import type { TendEvent } from './events.ts';
import type { Store } from './store.ts';
import { commitsSince } from './git.ts';
import { initialState, reduce } from './state.ts';
import type { SessionState } from './state.ts';

// The daily wrap-up (spec §22), built from the event log only: the cost of attention, not only the output.

export type Wrapup = {
  since: number;
  decisions: number;
  finished: number;
  started: number;
  interruptions: { sent: number; held: number };
  /** total time sessions spent waiting on you (ms) */
  waiting: number;
  commits: number;
};

/**
 * @param events every event since `since` (all sessions, oldest first)
 * @param before each session's state at `since` (sessions with no state default to starting)
 */
export function wrapup(o: {
  since: number;
  now: number;
  events: TendEvent[];
  before: Map<string, SessionState>;
  startedSince: number;
  notices: { kind: 'sent' | 'held' }[];
  commits: number;
}): Wrapup {
  const state = new Map(o.before);
  let waiting = 0;
  let decisions = 0;
  const finished = new Set<string>();
  const add = (s: SessionState, from: number, to: number): void => {
    if (s.status === 'needs_you') waiting += Math.max(0, to - Math.max(from, o.since));
  };
  const lastAt = new Map<string, number>();
  for (const ev of o.events) {
    const prev = state.get(ev.sessionId) ?? initialState(ev.ts);
    add(prev, lastAt.get(ev.sessionId) ?? o.since, ev.ts);
    const next = reduce(prev, ev);
    if (ev.kind === 'PermissionRequest') decisions++;
    // a finished turn is Claude's Stop after work (not a session that just became ready)
    if (ev.kind === 'Stop' && prev.status !== 'idle') finished.add(`${ev.sessionId}:${ev.ts}`);
    state.set(ev.sessionId, next);
    lastAt.set(ev.sessionId, ev.ts);
  }
  for (const [id, s] of state) add(s, lastAt.get(id) ?? o.since, o.now);
  return {
    since: o.since,
    decisions,
    finished: finished.size,
    started: o.startedSince,
    interruptions: { sent: o.notices.filter((n) => n.kind === 'sent').length, held: o.notices.filter((n) => n.kind === 'held').length },
    waiting,
    commits: o.commits,
  };
}

const CACHE_MS = 30_000;
let cache: { key: string; at: number; value: Wrapup } | null = null;

/** The wrap-up since `since` (ms; default: local midnight), from the store; cached 30 s; git runs async. */
export async function wrapupSince(store: Store, raw: number, now: number): Promise<Wrapup> {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const since = Number.isFinite(raw) && raw > 0 && raw <= now ? raw : day.getTime();
  const key = String(Math.floor(since / CACHE_MS));
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.value;
  const before = new Map<string, SessionState>();
  const rows = store.listSessions().filter((r) => !r.archived || r.createdAt >= since);
  const commits: Promise<number>[] = [];
  for (const r of rows) {
    if (r.archived) continue;
    let st = initialState(r.createdAt);
    for (const ev of store.eventsBefore(r.id, since)) st = reduce(st, ev);
    before.set(r.id, st);
    if (r.workspace.mode === 'worktree' && !r.paused) commits.push(commitsSince(r.workspace.worktree, r.workspace.base, since));
  }
  const startedSince = rows.filter((r) => r.createdAt >= since).length;
  const total = (await Promise.all(commits)).reduce((a, b) => a + b, 0);
  const value = wrapup({ since, now, events: store.eventsSince(since), before, startedSince, notices: store.noticesSince(since), commits: total });
  cache = { key, at: now, value };
  return value;
}
