import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { killSocket, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = tempHome();
const notifyFile = join(home, 'notify.jsonl');
let srv: Awaited<ReturnType<typeof startServer>>;

type Res = { status: number; json: () => any };

function call(method: string, path: string, body?: unknown, raw?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request(srv.url + path, { method, headers: { 'x-tend-token': srv.token, 'content-type': 'application/json' } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: () => JSON.parse(b) }));
    });
    r.on('error', reject);
    r.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}

async function until(fn: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}

const sessions = async (): Promise<any[]> => (await call('GET', '/api/sessions')).json();
const stateOf = async (id: string): Promise<any> => (await sessions()).find((s) => s.id === id)?.state;
const notes = (): any[] =>
  existsSync(notifyFile) ? readFileSync(notifyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const type = (id: string, text: string): Promise<Res> => call('POST', `/api/sessions/${id}/keys`, undefined, `${text}\r`);

before(async () => {
  srv = await startServer({
    TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'stub', TEND_CLAUDE_BIN: FAKE, TEND_WATCH_MS: '100',
    TEND_CLAUDE_ARGS: '--fake-trust',
  });
});

after(async () => {
  await srv?.stop();
  killSocket(socket);
});

test('a pane showing the trust dialog becomes needs_you/trust with one notification, and idle once accepted', async () => {
  const s = (await call('POST', '/api/sessions', { cwd: home, name: 'trusty', isolate: false })).json();
  await until(async () => (await stateOf(s.id))?.need === 'trust', 5000, 'needs_you/trust');
  assert.equal((await stateOf(s.id)).status, 'needs_you');
  await new Promise((r) => setTimeout(r, 500)); // several more watcher ticks
  const mine = notes().filter((n) => JSON.stringify(n).includes(s.id) || JSON.stringify(n).includes('trusty'));
  assert.equal(mine.filter((n) => JSON.stringify(n).includes('Asks you to trust the folder')).length, 1);

  await type(s.id, 'yes'); // accepted: Claude is at its prompt and sends no SessionStart
  await until(async () => (await stateOf(s.id))?.status === 'idle', 5000, 'idle after trust');
});
