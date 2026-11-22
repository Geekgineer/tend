// Review tab routes: the file tree with change stats, one file's text (now or at the session start),
// images for Markdown previews, and diffs with any amount of context. Read-only, token auth.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Ctx } from './server.ts';
import { HttpError, readJson, send } from './http.ts';
import { acquire, release } from './control-mode.ts';
import { readScreen } from './pane-sync.ts';
import { tmuxName } from './session-util.ts';
import { diffFor } from './git.ts';
import { changeStats, checkRel, IMAGE_MAX, imageType, listTree, readText, resolveInside, ReviewError, textAt } from './review.ts';

type Handler = (c: Ctx) => void | Promise<void>;

/** The folder a session's paths are relative to: its worktree, its repo top (in place), or its folder. */
function dirOf({ reg, id }: Ctx): string {
  const v = reg.get(id)!;
  const dir = v.workspace.mode === 'worktree' ? v.workspace.worktree : (reg.repoTop(id) ?? v.cwd);
  // a paused worktree session has its work committed and its folder put away until Resume
  if (!existsSync(dir)) throw new ReviewError(404, v.paused ? 'Paused: the files come back when you resume.' : "This session's folder is gone.");
  return dir;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ReviewError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

export const tree: Handler = (c) =>
  guard(async () => {
    const v = c.reg.get(c.id)!;
    const dir = dirOf(c);
    const isGit = v.git !== undefined;
    const [{ files, truncated }, changes] = await Promise.all([
      listTree(dir, isGit),
      isGit ? changeStats(dir, c.reg.diffBase(c.id), v.git!.changed) : Promise.resolve([]),
    ]);
    send(c.res, 200, { git: isGit, files, truncated, changes, ...(v.git?.changedTruncated ? { changesTruncated: true } : {}) });
  });

/** `?path=` the file now; `&at=start` as it was when the session began (git sessions only). */
export const file: Handler = (c) =>
  guard(async () => {
    const rel = checkRel(c.url.searchParams.get('path'));
    const dir = dirOf(c);
    if (c.url.searchParams.get('at') === 'start') {
      if (!c.reg.get(c.id)!.git) throw new ReviewError(404, 'Not a git session');
      const old = await textAt(dir, c.reg.diffBase(c.id) ?? 'HEAD', rel);
      send(c.res, 200, old ? { path: rel, ...old } : { path: rel, missing: true });
      return;
    }
    const f = await resolveInside(dir, rel);
    const image = imageType(rel) !== undefined;
    const body = image ? { text: '', binary: true, truncated: false, size: f.size } : await readText(f.abs);
    send(c.res, 200, { path: rel, ...body, ...(image ? { image: true } : {}), fp: `${f.size}:${Math.round(f.mtime)}` });
  });

/** An image from the session folder, served inert (sandboxed, never sniffed) for previews. */
export const raw: Handler = (c) =>
  guard(async () => {
    const rel = checkRel(c.url.searchParams.get('path'));
    const type = imageType(rel);
    if (!type) throw new ReviewError(415, 'Only images are served');
    const f = await resolveInside(dirOf(c), rel);
    if (f.size > IMAGE_MAX) throw new ReviewError(413, 'Image too large to preview');
    const data = await readFile(f.abs);
    c.res.writeHead(200, {
      'content-type': type,
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    c.res.end(data);
  });

/** A changed file's diff; `&context=full` shows the whole file around the changes. */
export const reviewDiff: Handler = (c) =>
  guard(async () => {
    const rel = checkRel(c.url.searchParams.get('path'));
    const v = c.reg.get(c.id)!;
    if (!v.git?.changed.includes(rel)) throw new ReviewError(404, 'Not a changed file of this session');
    const context = c.url.searchParams.get('context') === 'full' ? 100_000 : 3;
    send(c.res, 200, { path: rel, ...(await diffFor(dirOf(c), c.reg.diffBase(c.id), rel, context)) });
  });

export const REVIEW_MAX = 32 * 1024;
/** No control characters: the text goes inside a bracketed paste, and ESC[201~ in it would end the paste early. */
export const plainText = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');

/**
 * A review sent to Claude: pasted as one message, then Enter. Refused while Claude shows a dialog (a permission,
 * question or plan, or the trust prompt): that Enter would pick the highlighted answer. While Claude works, Claude
 * Code queues the message for when the step is done.
 */
export const say: Handler = async (c) => {
  const body = (await readJson(c.req, REVIEW_MAX + 1024)) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? plainText(body.text).trim() : '';
  if (!text || text.length > REVIEW_MAX) throw new HttpError(400, 'text is required (at most 32 KB)');
  const v = c.reg.get(c.id)!;
  if (v.paused || v.state.status === 'ended' || v.state.status === 'starting') throw new HttpError(409, 'The session is not running: resume it first.');
  if (v.state.status === 'needs_you' || v.decisions?.length) throw new HttpError(409, 'Claude is waiting for an answer: answer it first, then send the review.');
  let screen = '';
  try {
    screen = c.tmux.snapshot(tmuxName(c.id)).toString('utf8');
  } catch {
    throw new HttpError(404, 'Session not running');
  }
  if (readScreen(screen) === 'dialog') throw new HttpError(409, 'Claude is asking something in the terminal: answer it first, then send the review.');
  const client = acquire(c.socket, tmuxName(c.id));
  client.sendKeys(Buffer.from(`\x1b[200~${text}\x1b[201~\r`));
  release(client);
  send(c.res, 200, { sent: text.length });
};
