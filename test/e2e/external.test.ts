import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killSocket, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = realpathSync(tempHome());
let srv: Awaited<ReturnType<typeof startServer>>;
let config = '';

const api = async (method: string, path: string, body?: unknown, token = srv.token) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-tend-token': token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json()) as any };
};
const until = async (fn: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const SID = 'abcdef01-2345-4678-89ab-cdef01234567';
const deadPid = (): number => spawnSync('true').pid!;

before(async () => {
  srv = await startServer({ TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'off', TEND_CLAUDE_BIN: FAKE });
  config = process.env.CLAUDE_CONFIG_DIR!;
});
after(async () => {
  await srv?.stop();
  killSocket(socket);
});

test('sessions elsewhere are listed read-only, adopted only once closed, then resumed in place under tend', async () => {
  const dir = join(home, 'proj');
  mkdirSync(dir);
  const agents = (rows: unknown[]) => writeFileSync(join(config, 'agents.json'), JSON.stringify(rows));
  agents([{ pid: process.pid, cwd: dir, kind: 'interactive', startedAt: Date.now(), sessionId: SID, name: 'outside', status: 'busy' }]);

  assert.equal((await api('GET', '/api/external', undefined, '')).status, 401);
  const listed = (await api('GET', '/api/external')).body;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].live, true);
  assert.equal(listed[0].name, 'outside');

  // still open in its own terminal: never adopted (two processes on one conversation)
  let r = await api('POST', '/api/external/adopt', { sessionId: SID });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /still open/);
  assert.equal((await api('POST', '/api/external/adopt', { sessionId: 'x' })).status, 400);

  // it closes there; with no saved conversation there is nothing to resume
  agents([]);
  const listedPid = deadPid();
  agents([{ pid: listedPid, cwd: dir, kind: 'interactive', startedAt: Date.now(), sessionId: SID, name: 'outside', status: 'idle' }]);
  await api('POST', '/api/external/adopt', { sessionId: SID }); // re-reads (pid now dead but listed: still live)
  agents([]);
  r = await api('POST', '/api/external/adopt', { sessionId: SID });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no conversation/);

  mkdirSync(join(config, 'projects', '-proj'), { recursive: true });
  writeFileSync(join(config, 'projects', '-proj', `${SID}.jsonl`), '{}\n');
  r = await api('POST', '/api/external/adopt', { sessionId: SID });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = r.body;
  assert.equal(v.cwd, dir);
  assert.equal(v.name, 'outside');
  assert.equal(v.workspace.mode, 'inplace');

  const argvFile = join(home, 'sessions', v.id, 'argv.json');
  await until(() => existsSync(argvFile), 10_000, 'the adopted launch');
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
  assert.ok(argv.includes(`--resume=${SID}`), argv.join(' '));
  assert.ok(!argv.some((a) => a.startsWith('--session-id')));

  // now tend's: gone from Elsewhere, and can't be adopted twice
  assert.deepEqual((await api('GET', '/api/external')).body, []);
  r = await api('POST', '/api/external/adopt', { sessionId: SID });
  assert.equal(r.status, 409);
});
