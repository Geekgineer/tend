import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSocket, tempHome, uniqueSocket } from '../helpers.ts';

const CLI = join(import.meta.dirname, '..', '..', 'bin', 'tend.mjs');

/** A PATH holding only the named executables (symlinked from the real PATH). */
function minimalPath(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tend-path-'));
  for (const n of names) {
    const which = spawnSync('which', [n], { encoding: 'utf8' }).stdout.trim();
    if (which) symlinkSync(which, join(dir, n));
  }
  return dir;
}

function runCli(env: Record<string, string>, args: string[] = []): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('CLI prints the tmux message and exits 1 when tmux is missing', () => {
  const r = runCli({ PATH: minimalPath([]), TEND_HOME: tempHome() });
  assert.equal(r.status, 1);
  assert.match(r.out, /tend needs tmux\.\n  Install it: brew install tmux/);
});

test('CLI prints the claude message and exits 1 when claude is missing', () => {
  const r = runCli({ PATH: minimalPath(['tmux']), TEND_HOME: tempHome(), TEND_CLAUDE_BIN: 'claude' });
  assert.equal(r.status, 1);
  assert.match(r.out, /tend needs Claude Code\.\n  Install it: npm i -g @anthropic-ai\/claude-code/);
});

test('--version, --help, doctor and an unknown command answer without starting anything', () => {
  const home = tempHome();
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(runCli({ PATH: minimalPath([]), TEND_HOME: home }, ['--version']).out.trim(), pkg.version);
  const help = runCli({ PATH: minimalPath([]), TEND_HOME: home }, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.out, /tend doctor/);
  const sick = runCli({ PATH: minimalPath([]), TEND_HOME: home }, ['doctor']);
  assert.equal(sick.status, 1);
  assert.match(sick.out, /✗ tmux\s+→ brew install tmux/);
  assert.match(sick.out, /✗ Claude Code\s+→ npm i -g @anthropic-ai\/claude-code/);
  const bin = mkdtempSync(join(tmpdir(), 'tend-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const well = runCli({ PATH: `${bin}:${minimalPath(['tmux'])}`, TEND_HOME: home }, ['doctor']);
  assert.equal(well.status, 0, well.out);
  assert.match(well.out, /✓ Claude Code\s+9\.9\.9 \(Claude Code\)/);
  const bad = runCli({ PATH: minimalPath([]), TEND_HOME: home }, ['nope']);
  assert.equal(bad.status, 1);
  assert.match(bad.out, /Unknown command: nope\. Try: tend --help/);
  assert.equal(existsSync(join(home, 'lock')), false, 'nothing started');
});

test('CLI reports a busy port and exits 1', async () => {
  const blocker = createServer();
  await new Promise<void>((res) => blocker.listen(0, '127.0.0.1', res));
  const port = (blocker.address() as { port: number }).port;
  try {
    const bin = mkdtempSync(join(tmpdir(), 'tend-bin-'));
    const fake = join(bin, 'claude');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const c = spawn(process.execPath, [CLI], {
        env: { ...process.env, TEND_HOME: tempHome(), TEND_PORT: String(port), TEND_CLAUDE_BIN: fake, TEND_NOTIFY: 'off', TEND_TMUX_SOCKET: uniqueSocket() },
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('close', (status) => resolve({ status, out }));
    });
    assert.equal(r.status, 1);
    assert.match(r.out, new RegExp(`Port ${port} is busy\\. Is tend already running\\?`));
  } finally {
    blocker.close();
  }
});

test('CLI starts, prints the tokenized URL, and stops cleanly on SIGTERM', async () => {
  const socket = uniqueSocket();
  const home = tempHome();
  mkdirSync(home, { recursive: true });
  const bin = mkdtempSync(join(tmpdir(), 'tend-bin-'));
  const fake = join(bin, 'claude');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const probe = createServer();
  await new Promise<void>((res) => probe.listen(0, '127.0.0.1', res));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((res) => probe.close(() => res()));
  const c = spawn(process.execPath, [CLI], {
    env: { ...process.env, TEND_HOME: home, TEND_PORT: String(port), TEND_CLAUDE_BIN: fake, TEND_NOTIFY: 'off', TEND_TMUX_SOCKET: socket },
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error(`no URL line: ${out}`)), 10_000);
      c.stdout.on('data', (d) => {
        out += d;
        if (out.includes('\n')) {
          clearTimeout(t);
          resolve(out.split('\n')[0]);
        }
      });
    });
    assert.match(line, new RegExp(`^tend\\. running at http://127\\.0\\.0\\.1:${port}/\\?key=[0-9a-f]{64}$`));
    const code = await new Promise<number | null>((resolve) => {
      c.on('close', resolve);
      c.kill('SIGTERM');
    });
    assert.equal(code, 0);
  } finally {
    c.kill('SIGKILL');
    killSocket(socket);
  }
});

test('one tend per home; rotate-token swaps the link at once; the lock goes on stop; a stale lock is taken over', async () => {
  const socket = uniqueSocket();
  const home = tempHome();
  mkdirSync(home, { recursive: true });
  const bin = mkdtempSync(join(tmpdir(), 'tend-bin-'));
  const fake = join(bin, 'claude');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  writeFileSync(join(home, 'tend.lock'), JSON.stringify({ pid: 999_999, port: 1 })); // stale
  const probe = createServer();
  await new Promise<void>((res) => probe.listen(0, '127.0.0.1', res));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((res) => probe.close(() => res()));
  const env = { ...process.env, TEND_HOME: home, TEND_PORT: String(port), TEND_CLAUDE_BIN: fake, TEND_NOTIFY: 'off', TEND_TMUX_SOCKET: socket };
  const c = spawn(process.execPath, [CLI], { env });
  const get = (key: string) => new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/sessions', headers: { 'x-tend-token': key } }, (r) => {
      r.resume();
      resolve(r.statusCode!);
    }).on('error', reject).end();
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error(`no URL line: ${out}`)), 10_000);
      c.stdout.on('data', (d) => {
        out += d;
        if (out.includes('\n')) {
          clearTimeout(t);
          resolve(out.split('\n')[0]!);
        }
      });
    });
    const oldKey = /key=([0-9a-f]{64})/.exec(line)![1]!;
    assert.equal(JSON.parse(readFileSync(join(home, 'tend.lock'), 'utf8')).pid, c.pid);
    const second = spawnSync(process.execPath, [CLI], { env: { ...env, TEND_PORT: String(port + 1) }, encoding: 'utf8', timeout: 15_000 });
    assert.equal(second.status, 1);
    assert.match(second.stderr, new RegExp(`tend is already running at http://127\\.0\\.0\\.1:${port}/`));
    assert.equal(await get(oldKey), 200);
    const rot = spawnSync(process.execPath, [CLI, 'rotate-token'], { env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(rot.status, 0, rot.stderr);
    const newKey = /key=([0-9a-f]{64})/.exec(rot.stdout)![1]!;
    assert.notEqual(newKey, oldKey);
    await new Promise((r) => setTimeout(r, 2200)); // the running tend notices the token file within a second
    assert.equal(await get(oldKey), 401);
    assert.equal(await get(newKey), 200);
    await new Promise<void>((resolve) => {
      c.on('close', () => resolve());
      c.kill('SIGTERM');
    });
    assert.equal(existsSync(join(home, 'tend.lock')), false);
  } finally {
    c.kill('SIGKILL');
    killSocket(socket);
  }
});
