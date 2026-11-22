import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Every git command Tend runs lives here. Reads (status, diff, rev-list,
// rev-parse, ls-files, ...) go through readArgs so they never take locks
// that could collide with a running session's own git commands. No call
// runs the repo's hooks or its fsmonitor: Tend never executes repo code.
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

const firstLine = (text: unknown): string =>
  String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '') ?? '';

const gitError = (e: unknown): Error => {
  const err = e as { stderr?: unknown; message?: string };
  return new Error(firstLine(err.stderr) || err.message || 'git failed');
};

const run = (args: string[]): string => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw gitError(e);
  }
};

const runAsync = (args: string[]): Promise<string> =>
  new Promise((res, rej) => {
    execFile('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) rej(gitError({ stderr, message: err.message }));
      else res(stdout);
    });
  });

export function readArgs(dir: string, args: string[]): string[] {
  return ['--no-optional-locks', ...SAFE, '-C', dir, ...args];
}

const inTend = (p: string): boolean => p === '.tend' || p.startsWith('.tend/');

const read = (dir: string, args: string[]): string => run(readArgs(dir, args));
/** A read-only git command (no locks, hooks or fsmonitor) in `dir`, off the event loop. */
export const gitRead = (dir: string, args: string[]): Promise<string> => runAsync(readArgs(dir, args));
const write = (dir: string, args: string[]): string => run([...SAFE, '-C', dir, ...args]);

export type RepoInfo = { top: string; commonDir: string; head: string | null; dirty: boolean };

export function repoInfo(dir: string): RepoInfo | null {
  try {
    const top = realpathSync(read(dir, ['rev-parse', '--show-toplevel']).trim());
    const commonDir = realpathSync(resolve(dir, read(dir, ['rev-parse', '--git-common-dir']).trim()));
    let head: string | null = null;
    try {
      head = read(dir, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || null;
    } catch {
      head = null;
    }
    const dirty = read(dir, ['status', '--porcelain']).split('\n').some((l) => l !== '');
    return { top, commonDir, head, dirty };
  } catch {
    return null;
  }
}

export function branchName(name: string, id: string): string {
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  slug = slug.slice(0, 40).replace(/-+$/, '');
  if (slug === '') slug = 'session';
  const branch = `tend/${slug}-${id}`;
  run([...SAFE, 'check-ref-format', '--branch', branch]);
  return branch;
}

export function addWorktree(repo: string, path: string, branch: string, base: string): void {
  write(repo, ['worktree', 'add', '-b', branch, '--', path, base]);
}

export function reAddWorktree(repo: string, path: string, branch: string): void {
  write(repo, ['worktree', 'add', '--', path, branch]);
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export function worktreeOn(repo: string, path: string, branch: string): boolean {
  const want = real(path);
  let cur: string | null = null;
  for (const field of read(repo, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    if (field.startsWith('worktree ')) cur = real(field.slice(9));
    else if (field === 'branch refs/heads/' + branch && cur === want) return true;
    else if (field === '') cur = null;
  }
  return false;
}

export function branchExists(repo: string, branch: string): boolean {
  try {
    read(repo, ['show-ref', '--verify', '--quiet', '--', 'refs/heads/' + branch]);
    return true;
  } catch {
    return false;
  }
}

/** The full ref HEAD points at (`refs/heads/...`), or null on a detached HEAD. */
export function currentBranchRef(wt: string): string | null {
  try {
    return read(wt, ['symbolic-ref', '-q', '--', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

export function wipCommit(wt: string): string | null {
  write(wt, ['add', '-A', '--', '.']);
  if (!hasChanges(wt)) return null;
  write(wt, [
    '-c', 'commit.gpgsign=false', '-c', 'user.name=Tend', '-c', 'user.email=tend@localhost',
    'commit', '--no-verify', '-q', '-m', 'tend: paused (WIP)',
  ]);
  return read(wt, ['rev-parse', 'HEAD']).trim();
}

export function restoreWip(wt: string, wip: string): boolean {
  if (read(wt, ['rev-parse', 'HEAD']).trim() !== wip) return false;
  write(wt, ['reset', '--mixed', '-q', 'HEAD~1', '--']);
  return true;
}

/** Undo a `git add` that never became a commit (best effort for the caller). */
export function unstage(wt: string): void {
  write(wt, ['reset', '-q']);
}

export function ignoredEntries(wt: string): string[] {
  const all = read(wt, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
    .split('\0')
    .filter((e) => e !== '')
    .map((e) => e.replace(/\/+$/, ''))
    .sort();
  // a folder that ignores itself from inside (mypy's, pytest's and ruff's caches carry a "*" .gitignore) is listed
  // with its insides too: keep only the top-most entries, or moving the folder leaves the rest pointing at nothing
  const top: string[] = [];
  for (const e of all) if (!top.some((t) => e.startsWith(`${t}/`))) top.push(e);
  return top;
}

/** True when `git status --porcelain` lists anything (ignored files are not listed). */
export function hasChanges(wt: string): boolean {
  return read(wt, ['status', '--porcelain']).trim() !== '';
}

/** Forget worktrees whose folder is gone (deleted by hand). */
export function pruneWorktrees(repo: string): void {
  write(repo, ['worktree', 'prune']);
}

export function removeWorktree(repo: string, path: string): void {
  write(repo, ['worktree', 'remove', '--', path]);
}

export function deleteBranch(repo: string, branch: string): void {
  write(repo, ['branch', '-D', '--', branch]);
}

export type GitFacts = {
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  uncommitted: number;
  commits: number;
  changed: string[];
  /** Set when `changed` was cut at MAX_CHANGED paths. */
  changedTruncated?: true;
};

export const MAX_CHANGED = 500;

/** Cap a sorted path list at MAX_CHANGED entries. */
export function capChanged(paths: string[]): Pick<GitFacts, 'changed' | 'changedTruncated'> {
  return paths.length > MAX_CHANGED ? { changed: paths.slice(0, MAX_CHANGED), changedTruncated: true } : { changed: paths };
}

export async function facts(dir: string, base: string | null): Promise<GitFacts> {
  if (base !== null && !/^[0-9a-f]{7,64}$/.test(base)) throw new Error('invalid base commit');
  const out = await runAsync(readArgs(dir, ['status', '--porcelain=v2', '-b', '-z', '-uall']));
  let branch: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let uncommitted = 0;
  const paths = new Set<string>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '') continue;
    if (t.startsWith('# branch.head ')) {
      const h = t.slice(14);
      branch = h === '(detached)' ? null : h;
    } else if (t.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(t);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (t.startsWith('# ')) {
      continue;
    } else if (t.startsWith('1 ') || t.startsWith('u ') || t.startsWith('? ')) {
      const p = t.startsWith('1 ') ? nthField(t, 8) : t.startsWith('u ') ? nthField(t, 10) : t.slice(2);
      if (inTend(p)) continue;
      uncommitted++;
      paths.add(p);
    } else if (t.startsWith('2 ')) {
      const p = nthField(t, 9);
      const orig = i + 1 < tokens.length ? tokens[++i] : '';
      if (inTend(p) && inTend(orig)) continue;
      uncommitted++;
      paths.add(p);
      if (orig !== '') paths.add(orig);
    }
  }
  let commits = 0;
  if (base !== null) {
    const [count, diff] = await Promise.all([
      runAsync(readArgs(dir, ['rev-list', '--count', `${base}..HEAD`, '--'])),
      runAsync(readArgs(dir, ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`, '--'])),
    ]);
    commits = Number(count.trim()) || 0;
    for (const p of diff.split('\0')) if (p !== '') paths.add(p);
  }
  const changed = [...paths].filter((p) => !inTend(p)).sort();
  return { branch, ahead, behind, uncommitted, commits, ...capChanged(changed) };
}

// Path is everything after the first `n` space-separated fields (paths may contain spaces).
function nthField(entry: string, n: number): string {
  let idx = -1;
  for (let k = 0; k < n; k++) idx = entry.indexOf(' ', idx + 1);
  return entry.slice(idx + 1);
}

/** Commits on a session branch since `since` (ms), counted from its base. 0 when git can't tell or takes > 3 s. */
export async function commitsSince(wt: string, base: string, since: number): Promise<number> {
  const timeout = new Promise<string>((res) => setTimeout(() => res('0'), 3000).unref());
  try {
    const out = await Promise.race([runAsync(readArgs(wt, ['rev-list', '--count', `--since=@${Math.floor(since / 1000)}`, `${base}..HEAD`])), timeout]);
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

export const DIFF_MAX_LINES = 2000;
/** With the whole file as context (the Review tab's "Full file"), a longer cap. */
export const DIFF_FULL_MAX_LINES = 20000;
const UNTRACKED_MAX = 1024 * 1024;

/**
 * One file's diff for the Files panel: against the session base (worktree) or HEAD (in place), working tree
 * included; an untracked file shows as all added. `rel` must already be one of the session's changed paths.
 * Paths are literal (never globs). An untracked symlink shows its target (never what it points to); anything
 * but a regular file inside the folder is not read.
 */
export async function diffFor(dir: string, base: string | null, rel: string, context = 3): Promise<{ diff: string; truncated: boolean; binary: boolean }> {
  const none = { diff: '', truncated: false, binary: false };
  const cap = (text: string): { diff: string; truncated: boolean; binary: boolean } => {
    const lines = text.split('\n');
    const max = context > 3 ? DIFF_FULL_MAX_LINES : DIFF_MAX_LINES;
    return { diff: lines.slice(0, max).join('\n'), truncated: lines.length > max, binary: false };
  };
  const lit = (args: string[]): string[] => ['--literal-pathspecs', ...readArgs(dir, args)];
  let out = '';
  try {
    out = await runAsync(lit(['diff', '--no-color', '--no-ext-diff', '--no-renames', `-U${context}`, base ?? 'HEAD', '--', rel]));
  } catch {
    out = '';
  }
  if (/^Binary files /m.test(out)) return { ...none, binary: true };
  if (out.trim()) return cap(out);
  // only an untracked file is shown as new (a tracked one with no diff just has none)
  try {
    await runAsync(lit(['ls-files', '--error-unmatch', '--', rel]));
    return none;
  } catch {
    // untracked
  }
  const abs = join(dir, rel);
  if (!abs.startsWith(dir + '/')) return none;
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return cap(`new symlink ${rel}\n+${await readlink(abs)}`);
    if (!st.isFile()) return none;
    const real = await realpath(abs);
    if (!real.startsWith((await realpath(dir)) + '/')) return none;
    const fh = await open(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, UNTRACKED_MAX));
      await fh.read(buf, 0, buf.length, 0);
      if (buf.subarray(0, 8000).includes(0)) return { ...none, binary: true };
      const r = cap(`new file ${rel}\n${buf.toString('utf8').split('\n').map((l) => `+${l}`).join('\n')}`);
      return st.size > UNTRACKED_MAX ? { ...r, truncated: true } : r;
    } finally {
      await fh.close();
    }
  } catch {
    return none;
  }
}
