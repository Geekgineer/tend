import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTmux } from '../../src/tmux.ts';
import { ControlClient, acquire, activeClients, release } from '../../src/control-mode.ts';
import { killSocket, tempHome, uniqueSocket } from '../helpers.ts';

const sockets: string[] = [];
const children: ChildProcess[] = [];
const fresh = (): string => {
  const s = uniqueSocket();
  sockets.push(s);
  return s;
};
const raw = (socket: string, ...args: string[]): string =>
  execFileSync('tmux', ['-f', '/dev/null', '-L', socket, ...args], { encoding: 'utf8' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(50);
  }
  assert.fail('timed out');
};

after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const s of sockets) killSocket(s);
});

test('available, and ensureServerOptions is a no-op without a server', () => {
  const t = createTmux(fresh());
  assert.equal(t.available(), true);
  t.ensureServerOptions();
  assert.deepEqual(t.list(), []);
});

test('newSession in a dir with a space; snapshot has output', async () => {
  const t = createTmux(fresh());
  const dir = join(tempHome(), 'with space');
  mkdirSync(dir);
  t.newSession('s1', dir, ['sh', '-c', "printf '\\033[31mred\\033[0m'; sleep 30"], 80, 24, { FOO: 'bar' });
  assert.equal(t.has('s1'), true);
  assert.deepEqual(t.list(), ['s1']);
  await until(() => t.snapshot('s1').toString('latin1').includes('red'));
  const snap = t.snapshot('s1').toString('latin1');
  assert.ok(snap.startsWith('\x1b[2J\x1b[H'));
  assert.match(snap, /\x1b\[\d+;\d+H$/);
});

test('resize sets window size; a second attached client does not change it', async () => {
  const sock = fresh();
  const t = createTmux(sock);
  t.newSession('s2', tempHome(), ['sleep', '30'], 80, 24, {});
  t.resize('s2', 100, 30);
  assert.equal(raw(sock, 'display', '-p', '-t', 's2', '#{window_width}x#{window_height}').trim(), '100x30');
  const c = spawn('script', ['-q', '/dev/null', 'tmux', '-f', '/dev/null', '-L', sock, 'attach', '-t', 's2'], {
    stdio: 'ignore',
    detached: true,
  });
  children.push(c);
  await until(() => raw(sock, 'list-clients').trim().length > 0);
  await sleep(300);
  assert.equal(raw(sock, 'display', '-p', '-t', 's2', '#{window_width}x#{window_height}').trim(), '100x30');
  try {
    process.kill(-c.pid!, 'SIGKILL');
  } catch {
    c.kill('SIGKILL');
  }
});

test('paneDead after exit, kill removes the session', async () => {
  const t = createTmux(fresh());
  t.newSession('s3', tempHome(), ['true'], 80, 24, {});
  await until(() => t.paneDead('s3'));
  assert.equal(t.has('s3'), true);
  t.kill('s3');
  assert.equal(t.has('s3'), false);
  assert.equal(t.paneDead('s3'), false);
});

test('ControlClient streams output and sends keys', async () => {
  const sock = fresh();
  const t = createTmux(sock);
  t.newSession('tend-0000aa04', tempHome(), ['cat'], 80, 24, {});
  const cc = new ControlClient(sock, 'tend-0000aa04');
  let got = '';
  cc.onBytes((b) => (got += b.toString('latin1')));
  await sleep(300);
  cc.sendKeys(Buffer.from('hello\r'));
  await until(() => got.includes('hello'));
  cc.close();
});

test('ControlClient rejects session names that are not tend-<id>', () => {
  for (const name of ['s4', 'tend-0000aa0', 'tend-0000AA04', 'tend-0000aa04 ; kill-server', '=tend-0000aa04', 'tend-0000aa04:']) {
    assert.throws(() => new ControlClient('x', name), /session/i, name);
  }
});

test('ControlClient targets the exact session, not a prefix match', async () => {
  const sock = fresh();
  const t = createTmux(sock);
  // only a longer name exists: a prefix-matching attach to tend-0000aa05 would land on it
  t.newSession('tend-0000aa05x', tempHome(), ['cat'], 80, 24, {});
  const cc = new ControlClient(sock, 'tend-0000aa05');
  let exited = 0;
  cc.onExit(() => exited++);
  await until(() => exited === 1);
  cc.sendKeys(Buffer.from('nope\r'));
  await sleep(200);
  assert.doesNotMatch(raw(sock, 'capture-pane', '-p', '-t', '=tend-0000aa05x:'), /nope/);
  cc.close();
  assert.equal(exited, 1);
});

test('ControlClient onExit fires once when the session is killed', async () => {
  const sock = fresh();
  const t = createTmux(sock);
  t.newSession('tend-0000aa06', tempHome(), ['cat'], 80, 24, {});
  const cc = new ControlClient(sock, 'tend-0000aa06');
  let exited = 0;
  cc.onExit(() => exited++);
  await sleep(300);
  t.kill('tend-0000aa06');
  await until(() => exited === 1);
  await sleep(200);
  assert.equal(exited, 1);
  let late = 0;
  cc.onExit(() => late++); // registering after exit still fires (once)
  assert.equal(late, 1);
  cc.close();
});

test('acquire/release: one client per session, closed at 0, dead clients dropped', async () => {
  const sock = fresh();
  const t = createTmux(sock);
  t.newSession('tend-0000aa07', tempHome(), ['cat'], 80, 24, {});
  t.newSession('tend-0000aa08', tempHome(), ['cat'], 80, 24, {});
  const a = acquire(sock, 'tend-0000aa07');
  const b = acquire(sock, 'tend-0000aa07');
  assert.equal(a, b);
  const c = acquire(sock, 'tend-0000aa08');
  assert.notEqual(a, c);
  assert.equal(activeClients(), 2);
  let aExit = 0;
  a.onExit(() => aExit++);
  release(a);
  assert.equal(activeClients(), 2);
  release(b);
  assert.equal(activeClients(), 1);
  await until(() => aExit === 1);
  release(b); // over-release is a no-op
  assert.equal(activeClients(), 1);

  t.kill('tend-0000aa08');
  await until(() => activeClients() === 0);
  const d = acquire(sock, 'tend-0000aa08'); // a fresh client, not the dead one
  assert.notEqual(d, c);
  release(c); // releasing the dead client must not touch the new entry
  assert.equal(activeClients() <= 1, true);
  release(d);
  await until(() => activeClients() === 0);
});
