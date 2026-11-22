import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { launchOf, tempHome } from '../helpers.ts';
import { openStore } from '../../src/store.ts';
import { flag, git, lifecycleHarness, makeRepo, until } from './harness.ts';
import type { View } from './harness.ts';

const FIXTURE_GOAL = 'Create a file named hello.txt containing the word hi. Do nothing else.';
const h = lifecycleHarness();
const { home, call, create, type, turn, viewOf, stashOf, readArgv, resumeAndWaitArgv, hook, ready } = h;

test('dirty pause and resume keep tracked, untracked and ignored files byte-for-byte', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'dirty');
  const wt = v.workspace.worktree;
  const firstArgv = readArgv(v.id);
  const uuid = flag(firstArgv, '--session-id')!;
  await turn(v.id, 'hello');
  await turn(v.id, 'edit src/a.ts');
  const env = randomBytes(64);
  writeFileSync(join(wt, '.env'), env);
  mkdirSync(join(wt, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(wt, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(wt, 'dist'));
  writeFileSync(join(wt, 'dist', 'out.js'), 'built\n');
  writeFileSync(join(wt, 'README.md'), 'changed\n');
  // mypy's cache ignores itself from inside (found by the production soak: it used to fail the pause)
  mkdirSync(join(wt, '.mypy_cache', '3.14'), { recursive: true });
  writeFileSync(join(wt, '.mypy_cache', '.gitignore'), '*\n');
  writeFileSync(join(wt, '.mypy_cache', '3.14', 'm.json'), '{"m":1}');

  const p = await call('POST', `/api/sessions/${v.id}/pause`);
  assert.equal(p.status, 200, p.body);
  const pv = p.json() as View;
  assert.equal(pv.paused, true);
  assert.equal(pv.state.status, 'ended');
  assert.equal(existsSync(wt), false);
  assert.ok(git(repo, 'rev-parse', '--verify', `refs/heads/${v.workspace.branch}`));
  const stash = join(realpathSync(home), 'paused', v.id);
  assert.deepEqual(readFileSync(join(stash, '.env')), env);
  assert.ok(existsSync(join(stash, 'node_modules', 'pkg', 'index.js')));
  assert.equal((await viewOf(v.id))!.paused, true);

  const r = await resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  const rv = r.json() as View;
  assert.equal(rv.state.status, 'starting');
  assert.equal(rv.paused, false);
  assert.equal(readFileSync(join(wt, 'src', 'a.ts'), 'utf8'), 'x\n');
  assert.deepEqual(readFileSync(join(wt, '.env')), env);
  assert.equal(readFileSync(join(wt, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(readFileSync(join(wt, 'dist', 'out.js'), 'utf8'), 'built\n');
  assert.equal(readFileSync(join(wt, '.mypy_cache', '3.14', 'm.json'), 'utf8'), '{"m":1}');
  assert.equal(readFileSync(join(wt, 'README.md'), 'utf8'), 'changed\n');
  assert.equal(existsSync(stash), false);
  // the WIP commit is undone: the branch is back on base with the changes uncommitted
  assert.equal(git(wt, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  assert.match(git(wt, 'status', '--porcelain'), /README\.md/);
  assert.equal(flag(readArgv(v.id), '--resume'), uuid);
  await ready(v.id);
});

test('pause on a clean worktree makes no commit (branch tip === base)', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'clean');
  const p = await call('POST', `/api/sessions/${v.id}/pause`);
  assert.equal(p.status, 200, p.body);
  assert.equal(git(repo, 'rev-parse', `refs/heads/${v.workspace.branch}`), git(repo, 'rev-parse', 'main'));
});

test('clean pause after a real commit, then resume, keeps that commit as HEAD', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'real commit');
  const wt = v.workspace.worktree;
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'real');
  const real = git(wt, 'rev-parse', 'HEAD');
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  assert.equal(git(repo, 'rev-parse', `refs/heads/${v.workspace.branch}`), real);
  const r = await resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), real);
  assert.equal(readFileSync(join(wt, 'b.txt'), 'utf8'), 'b\n');
});

test('resume when never prompted uses --session-id <same uuid>', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'never prompted');
  const uuid = flag(readArgv(v.id), '--session-id')!;
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  const r = await resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  const argv = readArgv(v.id);
  assert.equal(flag(argv, '--session-id'), uuid);
  assert.equal(flag(argv, '--resume'), undefined);
  await ready(v.id);
});

test('resume of an ended in-place session restarts claude with --resume', async () => {
  const v = await create(tempHome(), 'in place');
  assert.equal(v.workspace.mode, 'inplace');
  const uuid = flag(readArgv(v.id), '--session-id')!;
  await turn(v.id, 'hello');
  type(v.id, 'exit');
  await until(async () => (await viewOf(v.id))?.state.status === 'ended', 5000, 'ended');
  const r = await resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json().state.status, 'starting');
  assert.equal(flag(readArgv(v.id), '--resume'), uuid);
  await ready(v.id);
});

test('SessionEnd received while the pane is alive → resume returns 400 "Session is still running."', async () => {
  const v = await create(tempHome(), 'alive');
  const h = await hook(v.id, launchOf(home, v.id), { hook_event_name: 'SessionEnd', session_id: 'x', reason: 'other' });
  assert.equal(h.status, 200);
  await until(async () => (await viewOf(v.id))?.state.status === 'ended', 2000, 'ended');
  const r = await call('POST', `/api/sessions/${v.id}/resume`);
  assert.equal(r.status, 400);
  assert.equal(r.json().error, 'Session is still running.');
});

test('pause in place → 400 exact copy', async () => {
  const v = await create(tempHome(), 'pause in place');
  const r = await call('POST', `/api/sessions/${v.id}/pause`);
  assert.equal(r.status, 400);
  assert.equal(r.json().error, 'Pause needs a session with its own worktree.');
});

test('resume after deleting the tend branch → 400 naming the branch, and no worktree dir', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'gone branch');
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  git(repo, 'branch', '-D', '--', v.workspace.branch);
  const r = await call('POST', `/api/sessions/${v.id}/resume`);
  assert.equal(r.status, 400);
  assert.equal(r.json().error, `Branch ${v.workspace.branch} no longer exists.`);
  assert.match(v.workspace.branch, /^tend\//);
  assert.equal(existsSync(v.workspace.worktree), false);
});

test('pause when the worktree is locked → 400, worktree, files and branch tip kept, not paused', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'locked');
  const wt = v.workspace.worktree;
  await turn(v.id, 'edit src/a.ts');
  writeFileSync(join(wt, '.env'), 'SECRET=1\n');
  const tip = git(repo, 'rev-parse', `refs/heads/${v.workspace.branch}`);
  git(repo, 'worktree', 'lock', wt);
  const r = await call('POST', `/api/sessions/${v.id}/pause`);
  assert.equal(r.status, 400);
  assert.match(r.json().error, /^Could not remove the worktree: \S/);
  assert.ok(existsSync(wt));
  assert.equal(git(repo, 'rev-parse', `refs/heads/${v.workspace.branch}`), tip);
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal(readFileSync(join(wt, 'src', 'a.ts'), 'utf8'), 'x\n');
  assert.match(git(wt, 'status', '--porcelain'), /\?\? src\//);
  const view = (await viewOf(v.id))!;
  assert.equal(view.paused, false);
  assert.equal(view.state.status, 'ended');
  assert.equal(existsSync(stashOf(v.id)), false, 'undo leaves no stash behind');
  git(repo, 'worktree', 'unlock', wt);
});

test('resume is idempotent when the worktree was already re-added', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'readded');
  const wt = v.workspace.worktree;
  await turn(v.id, 'edit src/a.ts');
  writeFileSync(join(wt, '.env'), 'E=1\n');
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  git(repo, 'worktree', 'add', '--', wt, v.workspace.branch);
  const r = await resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  assert.equal(readFileSync(join(wt, 'src', 'a.ts'), 'utf8'), 'x\n');
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'E=1\n');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
});

test('a SessionEnd posted with the old launch nonce after resume does not end the session', async () => {
  const v = await create(tempHome(), 'old nonce');
  await turn(v.id, 'hello');
  const old = launchOf(home, v.id);
  type(v.id, 'exit');
  await until(async () => (await viewOf(v.id))?.state.status === 'ended', 5000, 'ended');
  const r = await resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  assert.notEqual(launchOf(home, v.id), old);
  await hook(v.id, old, { hook_event_name: 'SessionEnd', session_id: 'x', reason: 'other' });
  assert.notEqual((await viewOf(v.id))?.state.status, 'ended');
});

test('archive removes the worktree, keeps the branch, hides the session and keeps its events', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'archive me');
  await turn(v.id, 'hello');
  const r = await call('POST', `/api/sessions/${v.id}/archive`);
  assert.equal(r.status, 204);
  assert.equal(r.body, '');
  assert.equal(existsSync(v.workspace.worktree), false);
  assert.ok(git(repo, 'rev-parse', '--verify', `refs/heads/${v.workspace.branch}`));
  assert.equal(await viewOf(v.id), undefined);
  assert.equal((await call('GET', `/api/sessions/${v.id}/briefing`)).status, 404);
  const store = openStore(join(home, 'tend.sqlite'));
  try {
    assert.ok(store.eventsFor(v.id).some((e) => e.kind === 'UserPromptSubmit'));
    assert.equal(store.getSession(v.id)!.archived, true);
  } finally {
    store.close();
  }
});

test('GET briefing after "hello" + "edit src/a.ts" returns the fixture goal, files and state', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'brief');
  await turn(v.id, 'hello');
  await turn(v.id, 'edit src/a.ts');
  const r = await call('GET', `/api/sessions/${v.id}/briefing`);
  assert.equal(r.status, 200);
  const b = r.json();
  assert.equal(b.goal, FIXTURE_GOAL);
  assert.deepEqual(b.files, ['src/a.ts']);
  assert.equal(b.state.status, 'idle');
});

test('pause with a held index.lock → 400 "Could not save work in progress: …", worktree and files intact, not paused', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'index lock');
  const wt = v.workspace.worktree;
  await turn(v.id, 'edit src/a.ts');
  writeFileSync(join(wt, '.env'), 'L=1\n');
  const lock = join(resolve(wt, git(wt, 'rev-parse', '--git-dir')), 'index.lock');
  writeFileSync(lock, '');
  try {
    const r = await call('POST', `/api/sessions/${v.id}/pause`);
    assert.equal(r.status, 400);
    assert.match(r.json().error, /^Could not save work in progress: \S/);
  } finally {
    rmSync(lock, { force: true });
  }
  assert.equal(readFileSync(join(wt, 'src', 'a.ts'), 'utf8'), 'x\n');
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'L=1\n');
  assert.equal(git(repo, 'rev-parse', `refs/heads/${v.workspace.branch}`), git(repo, 'rev-parse', 'main'));
  assert.equal((await viewOf(v.id))!.paused, false);
});

test('resume brings back a worktree that is gone even though the row is not marked paused', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'stuck');
  const wt = v.workspace.worktree;
  await turn(v.id, 'edit src/a.ts');
  writeFileSync(join(wt, '.env'), 'S=1\n');
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  // a crash between removeWorktree and the store update: the row never learned it was paused
  const store = openStore(join(home, 'tend.sqlite'));
  try {
    const row = store.getSession(v.id)!;
    store.updateSession(v.id, { paused: false, workspace: { ...(row.workspace as any), wip: null } });
  } finally {
    store.close();
  }
  assert.equal(existsSync(wt), false);
  const r = await resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  assert.equal(readFileSync(join(wt, 'src', 'a.ts'), 'utf8'), 'x\n');
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'S=1\n');
  await ready(v.id);
});

test('a stash clash on resume keeps the files in the stash with a warning; the next pause refuses with exact copy', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'clash');
  const wt = v.workspace.worktree;
  writeFileSync(join(wt, '.env'), 'OLD=1\n');
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  git(repo, 'worktree', 'add', '--', wt, v.workspace.branch);
  writeFileSync(join(wt, '.env'), 'NEW=1\n');
  const stash = stashOf(v.id);
  const r = await resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json().warning, `Some ignored files were kept in ${stash} because the worktree already has them.`);
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'NEW=1\n');
  assert.equal(readFileSync(join(stash, '.env'), 'utf8'), 'OLD=1\n');
  await ready(v.id);

  const p = await call('POST', `/api/sessions/${v.id}/pause`);
  assert.equal(p.status, 400);
  assert.equal(p.json().error, `Could not set aside ignored files: ${stash} still holds files from an earlier pause`);
  assert.ok(existsSync(wt));
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'NEW=1\n');
  assert.equal(readFileSync(join(stash, '.env'), 'utf8'), 'OLD=1\n');
  assert.equal((await viewOf(v.id))!.paused, false);
});

test('archive of an already-paused session keeps the stash and the WIP commit', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'archive paused');
  const wt = v.workspace.worktree;
  await turn(v.id, 'edit src/a.ts');
  writeFileSync(join(wt, '.env'), 'A=1\n');
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  const tip = git(repo, 'rev-parse', `refs/heads/${v.workspace.branch}`);
  assert.notEqual(tip, git(repo, 'rev-parse', 'main'));
  assert.equal(git(repo, 'log', '-1', '--format=%s', tip), 'tend: paused (WIP)');
  assert.equal((await call('POST', `/api/sessions/${v.id}/archive`)).status, 204);
  assert.equal(git(repo, 'rev-parse', `refs/heads/${v.workspace.branch}`), tip);
  assert.equal(readFileSync(join(stashOf(v.id), '.env'), 'utf8'), 'A=1\n');
  assert.equal(await viewOf(v.id), undefined);
});

test('a server restart while paused, then resume, restores every file', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'restart paused');
  const wt = v.workspace.worktree;
  await turn(v.id, 'edit src/a.ts');
  writeFileSync(join(wt, '.env'), 'R=1\n');
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  await h.restart();
  const pv = (await viewOf(v.id))!;
  assert.equal(pv.paused, true);
  assert.equal(pv.state.status, 'ended');
  const r = await resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  assert.equal(readFileSync(join(wt, 'src', 'a.ts'), 'utf8'), 'x\n');
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'R=1\n');
  assert.ok(flag(readArgv(v.id), '--resume'));
  await ready(v.id);
});
