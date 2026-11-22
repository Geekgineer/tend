// Media routes (v0.6): attachments in, attachments served. (Diffs live in review-routes.ts.)
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './server.ts';
import { first, HttpError, readRaw, send } from './http.ts';
import { acquire, release } from './control-mode.ts';
import { tmuxName } from './session-util.ts';
import { listAttachments, MAX_BYTES } from './attachments.ts';

type Handler = (c: Ctx) => void | Promise<void>;


const uploading = new Set<string>();
/** Upload one file: saved, normalised, and its quoted path pasted at the prompt (never submitted). */
export const upload: Handler = async ({ req, res, reg, socket, id }) => {
  const raw = first(req.headers['x-file-name']) ?? 'attachment';
  let name = 'attachment';
  try {
    name = decodeURIComponent(raw).slice(0, 200);
  } catch {
    // keep the default
  }
  if (uploading.has(id)) {
    req.resume(); // drain the body we won't read
    throw new HttpError(429, 'One upload at a time per session.');
  }
  uploading.add(id);
  let saved;
  try {
    saved = await reg.attach(id, name, await readRaw(req, MAX_BYTES));
  } finally {
    uploading.delete(id);
  }
  const client = acquire(socket, tmuxName(id));
  client.sendKeys(Buffer.from(`\x1b[200~${saved.insert}\x1b[201~`)); // bracketed paste: never Enter
  release(client);
  send(res, 201, { name: saved.name, kind: saved.kind, bytes: saved.bytes, insert: saved.insert, ...(saved.note ? { note: saved.note } : {}) });
};
export const attachmentsList: Handler = ({ res, reg, id }) => send(res, 200, listAttachments(reg.attachments(id)));

export const ATTACH_ROUTE = /^\/api\/sessions\/([^/]+)\/attachments\/([\w][\w.-]{0,120})$/;
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };
/** One attachment, served inert (sandboxed, no sniffing); images and PDFs inline, everything else downloads. */
export const attachmentFile = ({ res, reg, id, url }: Ctx): void => {
  const name = ATTACH_ROUTE.exec(url.pathname)![2]!;
  const ext = name.split('.').pop()!.toLowerCase();
  let data: Buffer;
  try {
    const file = join(reg.attachments(id), name);
    if (!lstatSync(file).isFile()) throw new Error('not a regular file'); // never follow a planted symlink
    data = readFileSync(file);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-disposition': TYPES[ext] ? 'inline' : 'attachment',
    // Chrome's PDF viewer won't run in a sandboxed document; PDFs get only nosniff
    ...(ext === 'pdf' ? {} : { 'content-security-policy': "sandbox; default-src 'none'; img-src 'self'" }),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(data);
};
