import { DatabaseSync } from 'node:sqlite';
import type { TendEvent } from './events.ts';

export type Workspace =
  // top: the repo's top folder for an in-place git session (rows before v0.2 final have none)
  | { mode: 'inplace'; top?: string }
  | { mode: 'worktree'; repo: string; commonDir: string; worktree: string; branch: string; base: string; subdir: string; wip: string | null };

export type SessionRow = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  endedAt: number | null;
  claudeId: string;
  launch: string;
  workspace: Workspace;
  paused: boolean;
  archived: boolean;
  /** the Claude config folder it runs under ('' = the default, for rows before v0.4) */
  account: string;
  /** the last context seen from its status line, as JSON ('' = none yet) */
  context: string;
};

export type Store = {
  addSession(r: SessionRow): void;
  listSessions(): SessionRow[];
  getSession(id: string): SessionRow | undefined;
  markEnded(id: string, at: number): void;
  updateSession(id: string, patch: Partial<Omit<SessionRow, 'id' | 'createdAt'>>): void;
  appendEvent(e: TendEvent): void;
  eventsFor(id: string): TendEvent[];
  /** Latest usage per account (config folder), as JSON. */
  listUsage(): { dir: string; json: string }[];
  /** One session's events before `ts`, oldest first. */
  eventsBefore(id: string, ts: number): TendEvent[];
  /** Every event since `ts` (all sessions), oldest first. */
  eventsSince(ts: number): TendEvent[];
  /** A notification sent or held (for the wrap-up). */
  addNotice(ts: number, sessionId: string, kind: 'sent' | 'held', urgent: boolean): void;
  noticesSince(ts: number): { kind: 'sent' | 'held'; urgent: boolean }[];
  putUsage(dir: string, json: string): void;
  close(): void;
};

type RawSession = {
  id: string;
  name: string;
  cwd: string;
  created_at: number;
  ended_at: number | null;
  claude_id: string;
  launch: string;
  workspace: string;
  paused: number;
  archived: number;
  account: string;
  context: string;
};

const MIGRATIONS: [column: string, ddl: string][] = [
  ['claude_id', "claude_id TEXT NOT NULL DEFAULT ''"],
  ['launch', "launch TEXT NOT NULL DEFAULT ''"],
  ['workspace', `workspace TEXT NOT NULL DEFAULT '{"mode":"inplace"}'`],
  ['paused', 'paused INTEGER NOT NULL DEFAULT 0'],
  ['archived', 'archived INTEGER NOT NULL DEFAULT 0'],
  ['account', "account TEXT NOT NULL DEFAULT ''"],
  ['context', "context TEXT NOT NULL DEFAULT ''"],
];

// SessionRow field -> column, with how to encode it for SQLite
const COLUMNS: Record<string, [column: string, enc: (v: never) => string | number | null]> = {
  name: ['name', (v) => v],
  cwd: ['cwd', (v) => v],
  endedAt: ['ended_at', (v) => v],
  claudeId: ['claude_id', (v) => v],
  launch: ['launch', (v) => v],
  workspace: ['workspace', (v) => JSON.stringify(v)],
  paused: ['paused', (v) => (v ? 1 : 0)],
  archived: ['archived', (v) => (v ? 1 : 0)],
  account: ['account', (v) => v],
  context: ['context', (v) => v],
};

function parseWorkspace(text: string): Workspace {
  try {
    return JSON.parse(text) as Workspace;
  } catch {
    return { mode: 'inplace' };
  }
}

function toSession(r: RawSession): SessionRow {
  return {
    id: r.id,
    name: r.name,
    cwd: r.cwd,
    createdAt: r.created_at,
    endedAt: r.ended_at ?? null,
    claudeId: r.claude_id,
    launch: r.launch,
    workspace: parseWorkspace(r.workspace),
    paused: r.paused !== 0,
    archived: r.archived !== 0,
    account: r.account ?? '',
    context: r.context ?? '',
  };
}

export function openStore(file: string): Store {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      tool TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_session_id ON events (session_id);
    CREATE TABLE IF NOT EXISTS usage (dir TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, urgent INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
  `);

  const have = new Set((db.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[]).map((c) => c.name));
  for (const [column, ddl] of MIGRATIONS) if (!have.has(column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`);

  const insSession = db.prepare(
    'INSERT INTO sessions (id, name, cwd, created_at, ended_at, claude_id, launch, workspace, paused, archived, account, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selUsage = db.prepare('SELECT dir, json FROM usage');
  const selSince = db.prepare('SELECT json FROM events WHERE ts >= ? ORDER BY id ASC');
  const selBefore = db.prepare('SELECT json FROM events WHERE session_id = ? AND ts < ? ORDER BY id ASC');
  const insNotice = db.prepare('INSERT INTO notices (ts, session_id, kind, urgent) VALUES (?, ?, ?, ?)');
  const selNotices = db.prepare('SELECT kind, urgent FROM notices WHERE ts >= ?');
  const putUsage = db.prepare('INSERT INTO usage (dir, json) VALUES (?, ?) ON CONFLICT(dir) DO UPDATE SET json = excluded.json');
  const selAll = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC');
  const selOne = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const upEnded = db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?');
  const insEvent = db.prepare('INSERT INTO events (session_id, ts, kind, tool, json) VALUES (?, ?, ?, ?, ?)');
  const selEvents = db.prepare('SELECT json FROM events WHERE session_id = ? ORDER BY id ASC');

  return {
    addSession(r) {
      insSession.run(
        r.id, r.name, r.cwd, r.createdAt, r.endedAt ?? null,
        r.claudeId, r.launch, JSON.stringify(r.workspace), r.paused ? 1 : 0, r.archived ? 1 : 0, r.account ?? '', r.context ?? '',
      );
    },
    listSessions() {
      return (selAll.all() as unknown as RawSession[]).map(toSession);
    },
    getSession(id) {
      const r = selOne.get(id) as unknown as RawSession | undefined;
      return r ? toSession(r) : undefined;
    },
    markEnded(id, at) {
      upEnded.run(at, id);
    },
    updateSession(id, patch) {
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      for (const [key, value] of Object.entries(patch)) {
        const col = COLUMNS[key];
        if (!col || value === undefined) continue;
        sets.push(`${col[0]} = ?`);
        vals.push(col[1](value as never));
      }
      if (sets.length === 0) return;
      db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    },
    appendEvent(e) {
      insEvent.run(e.sessionId, e.ts, e.kind, e.tool ?? null, JSON.stringify(e));
    },
    eventsFor(id) {
      return (selEvents.all(id) as unknown as { json: string }[]).map((r) => JSON.parse(r.json) as TendEvent);
    },
    listUsage() {
      return (selUsage.all() as unknown as { dir: string; json: string }[]).map((r) => ({ dir: r.dir, json: r.json }));
    },
    putUsage(dir, json) {
      putUsage.run(dir, json);
    },
    eventsBefore(id, ts) {
      return (selBefore.all(id, ts) as unknown as { json: string }[]).map((r) => JSON.parse(r.json) as TendEvent);
    },
    eventsSince(ts) {
      return (selSince.all(ts) as unknown as { json: string }[]).map((r) => JSON.parse(r.json) as TendEvent);
    },
    addNotice(ts, sessionId, kind, urgent) {
      insNotice.run(ts, sessionId, kind, urgent ? 1 : 0);
    },
    noticesSince(ts) {
      return (selNotices.all(ts) as unknown as { kind: 'sent' | 'held'; urgent: number }[]).map((r) => ({ kind: r.kind, urgent: r.urgent !== 0 }));
    },
    close() {
      db.close();
    },
  };
}
