// Claude sessions started outside tend ("Elsewhere"), from `claude agents --json` per account. Read-only: tend never
// signals, stops or types into them. Adopt resumes one under tend, and only after it has closed, so two Claude
// processes never write one conversation.
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import type { Account } from './accounts.ts';

export type ExternalRow = {
  sessionId: string;
  name: string;
  cwd: string;
  kind: 'interactive' | 'background';
  /** Claude's own word for it (busy, idle, …) while it runs */
  status: string;
  startedAt: number;
  account: string;
  /** still running in its own terminal (or as a background agent) */
  live: boolean;
  closedAt?: number;
  /** the short id `claude attach` takes (background sessions) */
  attachId?: string;
};

type Run = (argv: string[], env: Record<string, string | undefined>) => Promise<string>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FRESH_MS = 4000;
const KEEP_CLOSED_MS = 12 * 3600_000;
const LIST_TIMEOUT_MS = 8000;
const MISSING_FORGET_MS = 60_000;

/** Does the folder still exist? (closed temp folders, e.g. finished test runs, aren't worth offering) */
const folderExists = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const isClaudeSessionId = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

const defaultRun: Run = (argv, env) =>
  new Promise((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { env: env as NodeJS.ProcessEnv, timeout: LIST_TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });

/** Is a process still there? Signal 0 only checks; nothing is delivered. EPERM means it exists (another user). */
const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

type Listed = Omit<ExternalRow, 'account' | 'live' | 'closedAt'> & { pid: number };

/** One `claude agents --json` entry, or null when it doesn't look like one. */
export function parseEntry(x: unknown): Listed | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  if (!isClaudeSessionId(o.sessionId) || typeof o.cwd !== 'string' || !o.cwd.startsWith('/')) return null;
  if (o.kind !== 'interactive' && o.kind !== 'background') return null;
  const pid = typeof o.pid === 'number' && Number.isInteger(o.pid) && o.pid > 1 ? o.pid : 0;
  const name = typeof o.name === 'string' && o.name.trim() !== '' ? o.name.trim().slice(0, 200) : o.cwd.split('/').pop() || o.cwd;
  const row: Listed = {
    sessionId: o.sessionId,
    name,
    cwd: o.cwd,
    kind: o.kind,
    status: typeof o.status === 'string' ? o.status.slice(0, 40) : '',
    startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
    pid,
  };
  if (typeof o.id === 'string' && /^[0-9a-f]{4,64}$/.test(o.id)) row.attachId = o.id;
  return row;
}

export function createExternal(deps: {
  bin: () => string;
  accounts: () => Account[];
  /** the account that runs without CLAUDE_CONFIG_DIR (see forAccount) */
  homeClaude: string;
  /** Claude session ids tend itself runs (or ran): never listed as elsewhere */
  own: () => Set<string>;
  run?: Run;
  alive?: (pid: number) => boolean;
  exists?: (dir: string) => boolean;
  now?: () => number;
}) {
  const exists = deps.exists ?? folderExists;
  const run = deps.run ?? defaultRun;
  const alive = deps.alive ?? defaultAlive;
  const now = deps.now ?? Date.now;
  const rows = new Map<string, ExternalRow & { pid: number; missingSince?: number }>();
  let at = -Infinity; // never looked yet
  let inflight: Promise<void> | null = null;

  async function listAccount(a: Account): Promise<Listed[] | null> {
    const env: Record<string, string | undefined> = { ...process.env };
    if (a.dir === deps.homeClaude) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = a.dir;
    try {
      const parsed: unknown = JSON.parse(await run([deps.bin(), 'agents', '--json'], env));
      if (!Array.isArray(parsed)) return null;
      return parsed.map(parseEntry).filter((r): r is Listed => r !== null);
    } catch {
      return null; // not this account's fault to mark anything closed
    }
  }

  async function refresh(): Promise<void> {
    const accounts = deps.accounts();
    const results = await Promise.all(accounts.map(listAccount));
    const t = now();
    const seen = new Set<string>();
    results.forEach((listed, i) => {
      const account = accounts[i]!.dir;
      if (listed === null) {
        for (const r of rows.values()) if (r.account === account) seen.add(r.sessionId); // unknown: keep as is
        return;
      }
      for (const l of listed) {
        if (seen.has(l.sessionId)) continue; // listed under two accounts: first wins
        seen.add(l.sessionId);
        rows.set(l.sessionId, { ...l, account, live: true }); // (clears missingSince)
      }
    });
    for (const [id, r] of rows) {
      if (seen.has(id)) continue;
      // gone from the listing: closed, unless its process is somehow still there. Then wait a while, and if it
      // never comes back, forget it rather than call it closed (a reused pid, a lingering supervisor).
      if (r.live && r.pid > 0 && alive(r.pid)) {
        const since = r.missingSince ?? t;
        if (t - since > MISSING_FORGET_MS) rows.delete(id);
        else rows.set(id, { ...r, missingSince: since });
        continue;
      }
      if (r.live) rows.set(id, { ...r, live: false, closedAt: t, status: '', missingSince: undefined });
      else if (t - (r.closedAt ?? t) > KEEP_CLOSED_MS) rows.delete(id);
    }
    at = t;
  }

  return {
    /** Fresh enough rows, newest first; looks again at most every few seconds (only while someone asks). */
    async list(force = false): Promise<ExternalRow[]> {
      if (force || now() - at > FRESH_MS) {
        inflight ??= refresh().finally(() => (inflight = null));
        await inflight;
      }
      const own = deps.own();
      return [...rows.values()]
        .filter((r) => !own.has(r.sessionId) && (r.live || exists(r.cwd)))
        .sort((a, b) => Number(b.live) - Number(a.live) || (b.closedAt ?? b.startedAt) - (a.closedAt ?? a.startedAt))
        .map(({ pid: _pid, missingSince: _m, ...r }) => r);
    },
  };
}

export type External = ReturnType<typeof createExternal>;

/** Why a row can't be adopted, or null when it can. */
export function adoptBlocker(r: ExternalRow | undefined, hasTranscript: (id: string, account: string) => boolean): string | null {
  if (!r) return 'That session is no longer listed.';
  if (r.live) return 'It is still open. Close it there first (type /exit), then adopt it here.';
  if (!folderExists(r.cwd)) return 'Its folder is gone.';
  if (!hasTranscript(r.sessionId, r.account)) return 'Claude saved no conversation for it, so there is nothing to resume.';
  return null;
}
