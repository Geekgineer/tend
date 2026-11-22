import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Unexpected failures: write the stack to stderr (never request data, so never the token). */
export function logInternal(where: string, e: unknown): void {
  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
  process.stderr.write(`tend: internal error (${where}): ${detail}\n`);
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

export function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        reject(new HttpError(413, 'Request body too large'));
        return; // keep draining so the 413 can be written
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!done) reject(e);
      done = true;
    });
  });
}

export async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const text = (await readRaw(req, max)).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

