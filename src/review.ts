// The Review tab's reads: the session folder's file tree, one file's text (now or at the session start),
// images for Markdown previews, and per-file change stats. Read-only. Every path is checked twice: by
// its spelling (no `..`, no `.git`, nothing absolute) and by where it really lands (realpath inside the
// folder), so a symlink can never reach outside. Git runs through gitRead: no hooks, no locks.
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { gitRead } from './git.ts';

export const TREE_MAX = 20_000;
export const TEXT_MAX = 2 * 1024 * 1024;
export const IMAGE_MAX = 10 * 1024 * 1024;
const COUNT_MAX = 256 * 1024;
const WALK_SKIP = new Set(['.git', 'node_modules', '.tend', '.DS_Store', '__pycache__', '.venv', 'dist', 'build', '.next', 'target']);

export class ReviewError extends Error {
  status: 400 | 404 | 413 | 415;
  constructor(status: 400 | 404 | 413 | 415, message: string) {
    super(message);
    this.status = status;
  }
}

const inTend = (p: string): boolean => p === '.tend' || p.startsWith('.tend/');

/** A repo-relative path as typed by the UI: plain segments only. */
export function checkRel(rel: unknown): string {
  if (typeof rel !== 'string' || rel === '' || rel.length > 4096 || rel.includes('\0') || rel.includes('\\')) throw new ReviewError(400, 'Bad path');
  if (rel.startsWith('/')) throw new ReviewError(400, 'Bad path');
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw new ReviewError(400, 'Bad path');
  return rel;
}

/** The real file a checked path names, which must be a regular file inside `dir` (symlinks inside are fine). */
export async function resolveInside(dir: string, rel: string): Promise<{ abs: string; size: number; mtime: number }> {
  checkRel(rel);
  try {
    const root = await realpath(dir);
    const real = await realpath(join(dir, rel));
    if (!real.startsWith(root + sep)) throw new Error('outside');
    const st = await stat(real);
    if (!st.isFile()) throw new Error('not a file');
    return { abs: real, size: st.size, mtime: st.mtimeMs };
  } catch {
    throw new ReviewError(404, 'No such file in this session');
  }
}

/** Every file worth showing: git's tracked + untracked-not-ignored, or a bounded walk outside git. */
export async function listTree(dir: string, isGit: boolean): Promise<{ files: string[]; truncated: boolean }> {
  let files: string[] = [];
  if (isGit) {
    const out = await gitRead(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate']);
    files = [...new Set(out.split('\0'))].filter((p) => p !== '' && !inTend(p));
  } else {
    const root = dir;
    const queue = [''];
    while (queue.length && files.length <= TREE_MAX) {
      const rel = queue.shift()!;
      let entries;
      try {
        entries = await readdir(join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (WALK_SKIP.has(e.name)) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) queue.push(p); // symlinked folders are not followed (isDirectory is false for them)
        else if (e.isFile() || e.isSymbolicLink()) files.push(p);
      }
    }
  }
  files.sort();
  return files.length > TREE_MAX ? { files: files.slice(0, TREE_MAX), truncated: true } : { files, truncated: false };
}

export type Change = { path: string; status: 'A' | 'M' | 'D'; add: number | null; del: number | null; fp: string };

/** Per changed file: added / modified / deleted, line counts, and a fingerprint that moves when the file does. */
export async function changeStats(dir: string, base: string | null, changed: readonly string[]): Promise<Change[]> {
  const rev = base ?? 'HEAD';
  const num = new Map<string, [number | null, number | null]>();
  const status = new Map<string, 'A' | 'M' | 'D'>();
  try {
    const [n, s] = await Promise.all([
      gitRead(dir, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', rev, '--']),
      gitRead(dir, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', rev, '--']),
    ]);
    for (const rec of n.split('\0')) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
      if (m) num.set(m[3]!, [m[1] === '-' ? null : Number(m[1]), m[2] === '-' ? null : Number(m[2])]);
    }
    const t = s.split('\0');
    for (let i = 0; i + 1 < t.length; i += 2) {
      const k = t[i]![0];
      status.set(t[i + 1]!, k === 'A' ? 'A' : k === 'D' ? 'D' : 'M');
    }
  } catch {
    // no commits yet, or not a repo: everything below counts as new
  }
  const out: Change[] = [];
  for (const path of changed) {
    let fp = 'gone';
    let size = -1;
    try {
      const st = await lstat(join(dir, path));
      fp = `${st.size}:${Math.round(st.mtimeMs)}`;
      size = st.isFile() ? st.size : -1;
    } catch {
      // deleted
    }
    let [add, del] = num.get(path) ?? [null, null];
    let st = status.get(path);
    if (!st) {
      st = fp === 'gone' ? 'D' : 'A'; // untracked: git diff doesn't see it
      if (size >= 0 && size <= COUNT_MAX) add = await lineCount(join(dir, path)); // runs on every poll: small files only
      del = 0;
    }
    out.push({ path, status: st, add, del, fp });
  }
  return out;
}

async function lineCount(abs: string): Promise<number | null> {
  try {
    const { text, binary } = await readText(abs, TEXT_MAX);
    if (binary) return null;
    return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return null;
  }
}

/** A file's text, capped; NUL in the first 8 KB means binary. */
export async function readText(abs: string, max = TEXT_MAX): Promise<{ text: string; binary: boolean; truncated: boolean; size: number }> {
  const fh = await open(abs, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(size, max));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) return { text: '', binary: true, truncated: false, size };
    return { text: buf.toString('utf8'), binary: false, truncated: size > max, size };
  } finally {
    await fh.close();
  }
}

/** A file as it was at `rev` (the session start), or null if it didn't exist then. */
export async function textAt(dir: string, rev: string, rel: string): Promise<{ text: string; binary: boolean; truncated: boolean } | null> {
  checkRel(rel);
  if (!/^([0-9a-f]{7,64}|HEAD)$/.test(rev)) throw new ReviewError(400, 'Bad revision');
  let out: string;
  try {
    out = await gitRead(dir, ['show', '--no-textconv', `${rev}:${rel}`]);
  } catch {
    return null;
  }
  if (out.slice(0, 8000).includes('\0')) return { text: '', binary: true, truncated: false };
  return out.length > TEXT_MAX ? { text: out.slice(0, TEXT_MAX), binary: false, truncated: true } : { text: out, binary: false, truncated: false };
}

export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
};
export const imageType = (rel: string): string | undefined => IMAGE_TYPES[rel.split('.').pop()!.toLowerCase()];
