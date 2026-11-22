import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import xterm from '@xterm/headless';
import { activeClients } from '../../src/control-mode.ts';
import { killSocket, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const { Terminal } = xterm;
const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = tempHome();
let srv: Awaited<ReturnType<typeof startServer>>;

type Res = { status: number; headers: IncomingMessage['headers']; body: string; json: () => any };

function call(method: string, path: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request(srv.url + path, { method, headers: o.headers }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b, json: () => JSON.parse(b) }));
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

const auth = (extra: Record<string, string> = {}): Record<string, string> => ({ 'x-tend-token': srv.token, ...extra });
const json = (v: unknown): { headers: Record<string, string>; body: string } => ({
  headers: auth({ 'content-type': 'application/json' }),
  body: JSON.stringify(v),
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms: number, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}
const tmux = (...a: string[]): string => execFileSync('tmux', ['-f', '/dev/null', '-L', socket, ...a], { encoding: 'utf8' });

/** Open /term and parse its SSE frames; `chunks` receives decoded bytes for every `data:` frame. */
async function openTerm(id: string, onChunk: (b: Buffer) => void = () => {}): Promise<{ req: ClientRequest; res: IncomingMessage; ok: Promise<void>; ended: Promise<void> }> {
  const req = request(srv.url + `/api/sessions/${id}/term`, { headers: auth() });
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/event-stream/);
  let raw = '';
  let markOk!: () => void;
  const ok = new Promise<void>((r) => (markOk = r));
  const ended = new Promise<void>((r) => {
    res.on('end', () => r());
    res.on('close', () => r());
  });
  res.setEncoding('utf8');
  res.on('data', (c: string) => {
    raw += c;
    let i: number;
    while ((i = raw.indexOf('\n\n')) >= 0) {
      const block = raw.slice(0, i);
      raw = raw.slice(i + 2);
      if (block === ':ok') markOk();
      else if (block.startsWith('data: ')) onChunk(Buffer.from(block.slice(6), 'base64'));
    }
  });
  return { req, res, ok, ended };
}

async function newSession(): Promise<string> {
  const view = (await call('POST', '/api/sessions', json({ cwd: tempHome() }))).json();
  // wait until fake claude has drawn its prompt and is reading stdin
  await until(() => tmux('capture-pane', '-p', '-t', `=tend-${view.id}:`).includes('fake claude'), 5000, 'prompt');
  await sleep(200);
  return view.id;
}

before(async () => {
  srv = await startServer({ TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'off', TEND_CLAUDE_BIN: FAKE });
});

after(async () => {
  await srv?.stop();
  await until(() => activeClients() === 0, 2000, 'pool to drain');
  killSocket(socket);
});

test('terminal fidelity at 160x45 and after resizing to 100x30: 0 differing lines', async () => {
  const id = await newSession();
  const term = new Terminal({ cols: 160, rows: 45, allowProposedApi: true });
  const write = (b: Buffer): Promise<void> => new Promise((r) => term.write(b, r));
  const snapshot = async (): Promise<Buffer> => {
    const r = await call('GET', `/api/sessions/${id}/snapshot`, { headers: auth() });
    assert.equal(r.status, 200);
    return Buffer.from(r.body, 'base64');
  };
  const compare = (rows: number): string[] => {
    const b = term.buffer.active;
    const tm = tmux('capture-pane', '-p', '-t', `=tend-${id}:`).split('\n');
    const diffs: string[] = [];
    for (let y = 0; y < rows; y++) {
      const x = (b.getLine(b.baseY + y)?.translateToString(true) ?? '').trimEnd();
      const t = (tm[y] ?? '').trimEnd();
      if (x !== t) diffs.push(`line ${y}\n  xterm: ${JSON.stringify(x)}\n  tmux : ${JSON.stringify(t)}`);
    }
    return diffs;
  };
  const keys = async (s: string): Promise<void> => {
    const r = await call('POST', `/api/sessions/${id}/keys`, { headers: auth(), body: Buffer.from(s, 'utf8') });
    assert.equal(r.status, 204);
  };

  await write(await snapshot());
  let pending = Promise.resolve();
  const t = await openTerm(id, (b) => {
    pending = pending.then(() => write(b));
  });
  try {
    await t.ok;
    await keys('perm\n');
    await sleep(3000);
    await pending;
    assert.ok(tmux('capture-pane', '-p', '-t', `=tend-${id}:`).includes('Do you want to create test.txt?'), 'perm reached the pane');
    const d1 = compare(45);
    assert.equal(d1.length, 0, `160x45: ${d1.length} of 45 lines differ\n${d1.join('\n')}`);

    const r = await call('POST', `/api/sessions/${id}/resize`, json({ cols: 100, rows: 30 }));
    assert.equal(r.status, 204);
    assert.equal(tmux('display', '-p', '-t', `=tend-${id}:`, '#{window_width}x#{window_height}').trim(), '100x30');
    term.resize(100, 30);
    await sleep(500);
    await pending;
    await write(await snapshot()); // re-fetch after resize, as the spike did
    await keys('perm\n');
    await sleep(3000);
    await pending;
    const d2 = compare(30);
    assert.equal(d2.length, 0, `100x30: ${d2.length} of 30 lines differ\n${d2.join('\n')}`);
  } finally {
    t.res.destroy();
    t.req.destroy();
    term.dispose();
  }
});

test('opening and closing /term 20 times leaves no control clients behind', async () => {
  const id = await newSession();
  const base = activeClients();
  assert.equal(base, 0);
  for (let i = 0; i < 20; i++) {
    const t = await openTerm(id);
    await t.ok;
    assert.equal(activeClients(), 1, `open #${i + 1}`);
    t.res.destroy();
    t.req.destroy();
    await until(() => activeClients() === 0, 2000, `release #${i + 1}`);
  }
  assert.equal(activeClients(), 0);
});

test('two concurrent /term streams share one control client', async () => {
  const id = await newSession();
  const a = await openTerm(id);
  const b = await openTerm(id);
  try {
    await Promise.all([a.ok, b.ok]);
    assert.equal(activeClients(), 1);
    a.res.destroy();
    a.req.destroy();
    await sleep(200);
    assert.equal(activeClients(), 1);
  } finally {
    b.res.destroy();
    b.req.destroy();
  }
  await until(() => activeClients() === 0, 2000, 'release');
});

test('/term ends cleanly when the tmux session goes away', async () => {
  const id = await newSession();
  const t = await openTerm(id);
  await t.ok;
  tmux('kill-session', '-t', `=tend-${id}`);
  await Promise.race([t.ended, sleep(3000).then(() => assert.fail('stream did not end'))]);
  await until(() => activeClients() === 0, 2000, 'dead client dropped');
});

test('invalid or unknown ids are 404 on every terminal route', async () => {
  for (const id of ['zzz', 'ABCD1234', '0000000g', 'abcd1234']) {
    assert.equal((await call('GET', `/api/sessions/${id}/snapshot`, { headers: auth() })).status, 404, `snapshot ${id}`);
    assert.equal((await call('GET', `/api/sessions/${id}/term`, { headers: auth() })).status, 404, `term ${id}`);
    assert.equal((await call('POST', `/api/sessions/${id}/keys`, { headers: auth(), body: 'x' })).status, 404, `keys ${id}`);
    assert.equal((await call('POST', `/api/sessions/${id}/resize`, json({ cols: 80, rows: 24 }))).status, 404, `resize ${id}`);
  }
  assert.equal(activeClients(), 0);
});

test('terminal routes need the token', async () => {
  const id = await newSession();
  assert.equal((await call('GET', `/api/sessions/${id}/snapshot`)).status, 401);
  assert.equal((await call('GET', `/api/sessions/${id}/term`)).status, 401);
  assert.equal((await call('POST', `/api/sessions/${id}/keys`, { body: 'x' })).status, 401);
  assert.equal((await call('POST', `/api/sessions/${id}/resize`, { body: '{"cols":80,"rows":24}' })).status, 401);
  assert.equal((await call('GET', '/api/sessions/zzz/snapshot')).status, 401);
});

test('/keys: over 64 KB is a 413, empty body is a 204 no-op', async () => {
  const id = await newSession();
  const big = await call('POST', `/api/sessions/${id}/keys`, { headers: auth(), body: Buffer.alloc(64 * 1024 + 1, 0x61) });
  assert.equal(big.status, 413);
  const exact = await call('POST', `/api/sessions/${id}/keys`, { headers: auth(), body: Buffer.alloc(64 * 1024, 0x61) });
  assert.equal(exact.status, 204);
  const empty = await call('POST', `/api/sessions/${id}/keys`, { headers: auth() });
  assert.equal(empty.status, 204);
  await until(() => activeClients() === 0, 2000, 'keys client released');
});

test('/resize validates and clamps', async () => {
  const id = await newSession();
  const size = (): string => tmux('display', '-p', '-t', `=tend-${id}:`, '#{window_width}x#{window_height}').trim();
  assert.equal((await call('POST', `/api/sessions/${id}/resize`, json({ cols: 'x' }))).status, 400);
  assert.equal((await call('POST', `/api/sessions/${id}/resize`, json({ cols: 80 }))).status, 400);
  assert.equal((await call('POST', `/api/sessions/${id}/resize`, { headers: auth(), body: '{nope' })).status, 400);
  assert.equal(size(), '160x45');
  assert.equal((await call('POST', `/api/sessions/${id}/resize`, json({ cols: 1, rows: 1 }))).status, 204);
  assert.equal(size(), '20x5');
  assert.equal((await call('POST', `/api/sessions/${id}/resize`, json({ cols: 9999, rows: 9999 }))).status, 204);
  assert.equal(size(), '400x200');
  assert.equal((await call('POST', `/api/sessions/${id}/resize`, json({ cols: 120.6, rows: 33.2 }))).status, 204);
  assert.equal(size(), '121x33');
});
