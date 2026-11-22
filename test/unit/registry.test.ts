import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRegistry, UserError } from '../../src/sessions.ts';
import { openStore } from '../../src/store.ts';
import type { Tmux } from '../../src/tmux.ts';
import { tempHome } from '../helpers.ts';

function stubTmux(newSession: Tmux['newSession']): Tmux {
  return {
    available: () => true,
    ensureServerOptions: () => {},
    newSession,
    list: () => [],
    has: () => false,
    paneDead: () => false,
    kill: () => {},
    resize: () => {},
    snapshot: () => Buffer.alloc(0),
  };
}

test('create() records the session before tmux starts, and on a tmux failure ends it, removes its settings and rethrows', () => {
  const home = tempHome();
  const store = openStore(join(home, 'tend.sqlite'));
  let rowsAtStart = -1;
  const boom = new Error('tmux: socket path too long');
  const tmux = stubTmux(() => {
    rowsAtStart = store.listSessions().length;
    throw boom;
  });
  const reg = createRegistry({ store, tmux, home, port: 4977, token: 'a'.repeat(64), notify: () => {}, now: () => 42 });

  assert.throws(() => reg.create({ cwd: home }), (e) => e === boom);
  assert.equal(rowsAtStart, 1, 'store row exists before tmux is asked to start');
  const rows = store.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.endedAt, 42, 'row marked ended');
  assert.equal(existsSync(join(home, 'sessions', rows[0]!.id)), false, 'settings dir removed');
  assert.deepEqual(readdirSync(join(home, 'sessions')), []);
  assert.deepEqual(reg.list(), [], 'a session that never started is not listed live');
  store.close();
});

function liveRegistry() {
  const home = tempHome();
  const store = openStore(join(home, 'tend.sqlite'));
  const calls: { argv: string[] }[] = [];
  const tmux = stubTmux((_name, _cwd, argv) => {
    calls.push({ argv });
  });
  const reg = createRegistry({ store, tmux, home, port: 4977, token: 'a'.repeat(64), notify: () => {}, now: () => 42 });
  return { home, store, reg, calls };
}

test('create() stores a claude uuid and launch nonce and launches with --session-id', () => {
  const { home, store, reg, calls } = liveRegistry();
  const v = reg.create({ cwd: home });
  const row = store.getSession(v.id)!;
  assert.match(row.claudeId, /^[0-9a-f-]{36}$/);
  assert.match(row.launch, /^[0-9a-f]{16}$/);
  const argv = calls[0]!.argv;
  assert.ok(argv.includes(`--session-id=${row.claudeId}`));
  assert.equal(argv.filter((a: string) => a.startsWith('--session-id') || a.startsWith('--resume')).length, 1);
  const settings = JSON.parse(readFileSync(join(home, 'sessions', v.id, 'settings.json'), 'utf8')) as { hooks: { Stop: { hooks: { headers: Record<string, string> }[] }[] } };
  assert.equal(settings.hooks.Stop[0]!.hooks[0]!.headers['x-tend-launch'], row.launch);
  store.close();
});

test('ingest drops an event with a stale launch nonce', () => {
  const { home, store, reg } = liveRegistry();
  const v = reg.create({ cwd: home });
  const row = store.getSession(v.id)!;
  assert.equal(reg.ingest(v.id, { hook_event_name: 'UserPromptSubmit' }, 'stale'), true);
  assert.equal(reg.ingest(v.id, { hook_event_name: 'UserPromptSubmit' }, undefined), true);
  assert.deepEqual(store.eventsFor(v.id), []);
  assert.equal(reg.get(v.id)!.state.status, 'starting');
  assert.equal(reg.ingest(v.id, { hook_event_name: 'UserPromptSubmit' }, row.launch), true);
  assert.equal(store.eventsFor(v.id).length, 1);
  assert.equal(reg.get(v.id)!.state.status, 'working');
  store.close();
});

test('a v0.1 row (launch empty) accepts any nonce, including none', () => {
  const { home, store, reg } = liveRegistry();
  const v = reg.create({ cwd: home });
  store.updateSession(v.id, { launch: '' });
  assert.equal(reg.ingest(v.id, { hook_event_name: 'Stop' }), true);
  assert.equal(reg.ingest(v.id, { hook_event_name: 'Stop' }, 'whatever'), true);
  assert.equal(store.eventsFor(v.id).length, 2);
  store.close();
});

test('ingest with a new claude session_id updates claudeId (accepted events only)', () => {
  const { home, store, reg } = liveRegistry();
  const v = reg.create({ cwd: home });
  const row = store.getSession(v.id)!;
  const stale = '11111111-2222-4333-8444-555555555555';
  const cleared = '66666666-7777-4888-9999-aaaaaaaaaaaa';
  reg.ingest(v.id, { hook_event_name: 'Stop', session_id: stale }, 'stale');
  assert.equal(store.getSession(v.id)!.claudeId, row.claudeId);
  reg.ingest(v.id, { hook_event_name: 'Stop', session_id: cleared }, row.launch);
  assert.equal(store.getSession(v.id)!.claudeId, cleared);
  store.close();
});

test('a hook session_id that is not a UUID never changes claudeId', () => {
  const { home, store, reg } = liveRegistry();
  const v = reg.create({ cwd: home });
  const row = store.getSession(v.id)!;
  for (const bad of ['../../etc/passwd', '--settings=/x']) {
    reg.ingest(v.id, { hook_event_name: 'Stop', session_id: bad }, row.launch);
    assert.equal(store.getSession(v.id)!.claudeId, row.claudeId, bad);
  }
  store.close();
});

test('resume replaces a stored claudeId that is not a UUID with a fresh one and does not --resume it', async () => {
  const { home, store, reg, calls } = liveRegistry();
  const v = reg.create({ cwd: home });
  store.updateSession(v.id, { claudeId: '--settings=/x', endedAt: 1 });
  reg.reconcile(2);
  await reg.resume(v.id);
  const argv = calls.at(-1)!.argv;
  const id = store.getSession(v.id)!.claudeId;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(argv.includes(`--session-id=${id}`));
  assert.ok(!argv.some((a) => a.includes('/x')));
  store.close();
});

test('a tmux failure after the worktree was made removes the worktree and the branch and archives the row', () => {
  const home = tempHome();
  const repo = join(tempHome(), 'my #repo');
  mkdirSync(repo);
  const git = (...a: string[]): string => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  const store = openStore(join(home, 'tend.sqlite'));
  let worktree = '';
  const tmux = stubTmux((_n, cwd) => {
    worktree = cwd;
    assert.ok(existsSync(cwd), 'worktree exists when tmux starts');
    throw new Error('boom');
  });
  const reg = createRegistry({ store, tmux, home, port: 4977, token: 'a'.repeat(64), notify: () => {}, now: () => 42 });
  assert.throws(() => reg.create({ cwd: repo }), /boom/);
  assert.equal(existsSync(worktree), false, 'worktree removed');
  assert.equal(git('branch', '--list', 'tend/*').trim(), '');
  const row = store.listSessions()[0]!;
  assert.equal(row.archived, true);
  assert.deepEqual(row.workspace, { mode: 'inplace' });
  assert.deepEqual(reg.list(), []);
  store.close();
});

test('boot skips archived rows', () => {
  const { home, store, reg } = liveRegistry();
  const v = reg.create({ cwd: home, isolate: false });
  store.updateSession(v.id, { archived: true });
  const tmux = stubTmux(() => {});
  const reg2 = createRegistry({ store, tmux, home, port: 4977, token: 'a'.repeat(64), notify: () => {}, now: () => 42 });
  assert.deepEqual(reg2.list(), []);
  assert.equal(reg2.get(v.id), undefined);
});

test('a worktree that cannot be created is a 400-style UserError and no row is left', () => {
  const home = tempHome();
  const repo = join(tempHome(), 'r');
  mkdirSync(repo);
  const git = (...a: string[]): string => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  writeFileSync(join(home, 'worktrees'), 'x');
  const store = openStore(join(home, 'tend.sqlite'));
  const reg = createRegistry({ store, tmux: stubTmux(() => {}), home, port: 4977, token: 'a'.repeat(64), notify: () => {}, now: () => 42 });
  assert.throws(() => reg.create({ cwd: repo }), (e) => e instanceof UserError && /^Could not create the worktree: /.test(e.message));
  assert.deepEqual(store.listSessions(), []);
  store.close();
});

test('pause and archive stop with a UserError, touching no git, when the tmux session will not die', async () => {
  const home = tempHome();
  const repo = join(tempHome(), 'my #repo');
  mkdirSync(repo);
  const git = (...a: string[]): string => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  const store = openStore(join(home, 'tend.sqlite'));
  const tmux: Tmux = { ...stubTmux(() => {}), has: () => true };
  const reg = createRegistry({ store, tmux, home, port: 4977, token: 'a'.repeat(64), notify: () => {}, now: () => 42, killWaitMs: 50 });
  const v = reg.create({ cwd: repo });
  assert.equal(v.workspace.mode, 'worktree');
  const wt = (v.workspace as { worktree: string }).worktree;
  const branch = (v.workspace as { branch: string }).branch;
  writeFileSync(join(wt, 'dirty.txt'), 'd\n');
  const stuck = (e: unknown): boolean => e instanceof UserError && e.message === 'The session did not stop. Try again.';
  await assert.rejects(reg.pause(v.id), stuck);
  await assert.rejects(reg.archive(v.id), stuck);
  assert.ok(existsSync(join(wt, 'dirty.txt')));
  assert.equal(git('rev-parse', `refs/heads/${branch}`), git('rev-parse', 'main'), 'no WIP commit');
  const row = store.getSession(v.id)!;
  assert.equal(row.paused, false);
  assert.equal(row.archived, false);
  assert.equal(row.endedAt, null);
  assert.equal(reg.get(v.id)!.state.status, 'starting');
  store.close();
});

test('pause, resume or archive queued behind an archive fail with "Session not found." (never a 500)', async () => {
  const { home, store, reg } = liveRegistry();
  const v = reg.create({ cwd: home, isolate: false });
  const archived = reg.archive(v.id);
  const later = [reg.pause(v.id), reg.resume(v.id), reg.archive(v.id)];
  await archived;
  for (const p of later) await assert.rejects(p, (e) => e instanceof UserError && e.message === 'Session not found.');
  store.close();
});
