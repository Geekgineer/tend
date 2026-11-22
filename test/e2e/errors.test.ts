import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { killSocket, launchOf, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const FIX = join(import.meta.dirname, '..', 'fixtures', 'phase0');
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

function call(url: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request(url + path, { method, headers }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: b }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

/** Collect everything written to stderr until the returned stop() is called. */
function captureStderr(): { text: () => string; stop: () => void } {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    void rest;
    return true;
  }) as typeof process.stderr.write;
  return { text: () => buf, stop: () => void (process.stderr.write = orig) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('an internal error in a handler is answered 500 and its stack goes to stderr (without the token)', async () => {
  // a socket name too long for a unix socket path: every tmux call fails
  const socket = `tend-test-${'x'.repeat(120)}`;
  const srv = await startServer({ TEND_HOME: tempHome(), TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'off', TEND_CLAUDE_BIN: FAKE });
  cleanups.push(() => srv.stop());
  const cap = captureStderr();
  let r;
  try {
    r = await call(srv.url, 'POST', '/api/sessions', { 'x-tend-token': srv.token, 'content-type': 'application/json' }, JSON.stringify({ cwd: tempHome() }));
  } finally {
    cap.stop();
  }
  assert.equal(r.status, 500);
  assert.deepEqual(JSON.parse(r.body), { error: 'Internal error' });
  assert.match(cap.text(), /tend: internal error/);
  assert.match(cap.text(), /\n\s+at /, 'a stack trace is logged');
  assert.ok(!cap.text().includes(srv.token), 'the token is never logged');
});

test('a failure while ingesting a hook (after the 200) is logged to stderr', async () => {
  const socket = uniqueSocket();
  const home = tempHome();
  const srv = await startServer({ TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'off', TEND_CLAUDE_BIN: FAKE });
  cleanups.push(() => killSocket(socket));
  cleanups.push(() => srv.stop());
  const auth = { 'x-tend-token': srv.token, 'content-type': 'application/json' };
  const created = await call(srv.url, 'POST', '/api/sessions', auth, JSON.stringify({ cwd: tempHome() }));
  assert.equal(created.status, 201);
  const { id } = JSON.parse(created.body) as { id: string };

  // another connection holds the write lock: the server's event insert fails with SQLITE_BUSY
  const lock = new DatabaseSync(join(home, 'tend.sqlite'));
  lock.exec('BEGIN EXCLUSIVE');
  const cap = captureStderr();
  let r;
  try {
    const body = readFileSync(join(FIX, '002-UserPromptSubmit.json'), 'utf8');
    r = await call(srv.url, 'POST', '/hook', { ...auth, 'x-tend-session': id, 'x-tend-launch': launchOf(home, id) }, body);
    await sleep(100);
  } finally {
    cap.stop();
    lock.exec('ROLLBACK');
    lock.close();
  }
  assert.equal(r.status, 200);
  assert.match(cap.text(), /tend: internal error \(hook ingest\)/);
  assert.match(cap.text(), /locked|busy/i);
});
