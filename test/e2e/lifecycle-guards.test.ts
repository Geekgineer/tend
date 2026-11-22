import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../../src/store.ts';
import { tempHome } from '../helpers.ts';
import { git, lifecycleHarness, makeRepo } from './harness.ts';

const h = lifecycleHarness();
const { call, create, turn, viewOf, stashOf } = h;

/** Pause must fail with `copy`, leaving files, HEAD and the branch tip as they were. */
async function assertPauseRefused(id: string, wt: string, branch: string, copy: string): Promise<void> {
  const head = git(wt, 'rev-parse', 'HEAD');
  const tip = git(wt, 'rev-parse', `refs/heads/${branch}`);
  const status = git(wt, 'status', '--porcelain');
  const r = await call('POST', `/api/sessions/${id}/pause`);
  assert.equal(r.status, 400, r.body);
  assert.equal(r.json().error, copy);
  assert.equal(readFileSync(join(wt, 'src', 'a.ts'), 'utf8'), 'x\n');
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'E=1\n');
  assert.equal(readFileSync(join(wt, 'README.md'), 'utf8'), 'changed\n');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head, 'no WIP commit');
  assert.equal(git(wt, 'rev-parse', `refs/heads/${branch}`), tip);
  assert.equal(git(wt, 'status', '--porcelain'), status, 'nothing staged or moved');
  assert.equal(existsSync(stashOf(id)), false, 'no stash');
  assert.equal((await viewOf(id))!.paused, false);
  assert.notEqual((await viewOf(id))!.state.status, 'ended', 'a refused pause leaves Claude running');
}

async function dirtySession(name: string): Promise<{ id: string; wt: string; branch: string }> {
  const v = await create(makeRepo(), name);
  const wt = v.workspace.worktree;
  await turn(v.id, 'edit src/a.ts');
  writeFileSync(join(wt, '.env'), 'E=1\n');
  writeFileSync(join(wt, 'README.md'), 'changed\n');
  return { id: v.id, wt, branch: v.workspace.branch };
}

test('pause of a worktree on a detached HEAD → 400, files intact, no WIP commit, not paused', async () => {
  const { id, wt, branch } = await dirtySession('detached');
  git(wt, 'checkout', '-q', '--detach');
  await assertPauseRefused(id, wt, branch, `The worktree is on a detached HEAD, not ${branch}. Switch back before pausing.`);
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'still detached');
});

test('pause after `git switch -c other` in the worktree → 400 naming other, nothing committed on other', async () => {
  const { id, wt, branch } = await dirtySession('switched');
  git(wt, 'switch', '-q', '-c', 'other');
  const otherTip = git(wt, 'rev-parse', 'refs/heads/other');
  await assertPauseRefused(id, wt, branch, `The worktree is on other, not ${branch}. Switch back before pausing.`);
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'other');
  assert.equal(git(wt, 'rev-parse', 'refs/heads/other'), otherTip);
});

test('archive of a worktree on another branch → 400 and the session stays', async () => {
  const { id, wt, branch } = await dirtySession('archive switched');
  git(wt, 'switch', '-q', '-c', 'other2');
  const r = await call('POST', `/api/sessions/${id}/archive`);
  assert.equal(r.status, 400, r.body);
  assert.equal(r.json().error, `The worktree is on other2, not ${branch}. Switch back before pausing.`);
  assert.ok(await viewOf(id));
  assert.equal(readFileSync(join(wt, 'README.md'), 'utf8'), 'changed\n');
});

test('resume warns when the WIP commit is no longer the branch tip', async () => {
  const { id, branch } = await dirtySession('moved');
  assert.equal((await call('POST', `/api/sessions/${id}/pause`)).status, 200);
  const store = openStore(join(h.home, 'tend.sqlite'));
  let main = '';
  let sha = '';
  try {
    const row = store.getSession(id)!;
    if (row.workspace.mode !== 'worktree') throw new Error('expected a worktree');
    main = row.workspace.repo;
    sha = row.workspace.wip!;
  } finally {
    store.close();
  }
  // move the branch past the WIP commit by hand
  git(main, 'branch', '-f', branch, git(main, 'commit-tree', '-p', sha, '-m', 'later', `${sha}^{tree}`));
  const r = await h.resumeAndWaitArgv(id);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json().warning, `The paused work is in commit ${sha.slice(0, 7)} but the branch has moved; restore it by hand if needed.`);
  await h.ready(id);
});

/** A repo with an (untracked, empty) packages/api folder to start sessions in. */
function repoWithApi(): { repo: string; api: string } {
  const repo = makeRepo();
  const api = join(repo, 'packages', 'api');
  mkdirSync(api, { recursive: true });
  return { repo, api };
}

test('briefing files of an in-place session are relative to the repo top, not the start folder', async () => {
  const { api } = repoWithApi();
  const v = await create(api, 'inplace sub', false);
  assert.equal(v.workspace.mode, 'inplace');
  await turn(v.id, 'edit ../../README.md');
  await turn(v.id, 'edit src/a.ts');
  assert.deepEqual((await h.briefing(v.id)).files, ['README.md', 'packages/api/src/a.ts']);
});

test('briefing files of a worktree session are relative to the worktree root', async () => {
  const { api } = repoWithApi();
  const v = await create(api, 'worktree sub');
  assert.equal(v.workspace.mode, 'worktree');
  await turn(v.id, 'edit ../../README.md');
  await turn(v.id, 'edit src/a.ts');
  assert.deepEqual((await h.briefing(v.id)).files, ['README.md', 'packages/api/src/a.ts']);
});

const panePath = (id: string): string => realpathSync(h.tmux('display', '-p', '-t', `=tend-${id}:`, '#{pane_current_path}').trim());

test('resume of a session started in an empty untracked subfolder starts claude in that subfolder of the worktree', async () => {
  const { api } = repoWithApi();
  const v = await create(api, 'empty sub');
  const want = join(realpathSync(v.workspace.worktree), 'packages', 'api');
  assert.equal(panePath(v.id), want);
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  const r = await h.resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  assert.equal(panePath(v.id), want);
});

test('resume of an in-place session whose folder is gone → 400 "Folder not found: <cwd>"', async () => {
  const dir = join(realpathSync(tempHome()), 'gone');
  mkdirSync(dir);
  const v = await create(dir, 'gone folder');
  await h.exit(v.id);
  rmSync(dir, { recursive: true });
  const r = await call('POST', `/api/sessions/${v.id}/resume`);
  assert.equal(r.status, 400, r.body);
  assert.equal(r.json().error, `Folder not found: ${dir}`);
  assert.equal((await viewOf(v.id))!.state.status, 'ended');
});

test('an ignored .tend/notes survives pause and resume', async () => {
  const v = await create(makeRepo('.env\n.tend/\n'), 'tend notes');
  const wt = v.workspace.worktree;
  mkdirSync(join(wt, '.tend'));
  writeFileSync(join(wt, '.tend', 'notes'), 'keep me\n');
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  assert.equal(readFileSync(join(stashOf(v.id), '.tend', 'notes'), 'utf8'), 'keep me\n');
  const r = await h.resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  assert.equal(readFileSync(join(wt, '.tend', 'notes'), 'utf8'), 'keep me\n');
});

test('archive succeeds when the worktree folder was deleted by hand', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'deleted then archived');
  await h.exit(v.id);
  rmSync(v.workspace.worktree, { recursive: true, force: true });
  const r = await call('POST', `/api/sessions/${v.id}/archive`);
  assert.equal(r.status, 204, r.body);
  assert.equal(await viewOf(v.id), undefined);
  assert.ok(git(repo, 'rev-parse', '--verify', `refs/heads/${v.workspace.branch}`), 'branch kept');
  assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes(v.workspace.worktree), 'git forgot the deleted worktree');
});

test('pause of a worktree deleted by hand says so instead of blaming a detached HEAD', async () => {
  const v = await create(makeRepo(), 'deleted then paused');
  rmSync(v.workspace.worktree, { recursive: true, force: true });
  const r = await call('POST', `/api/sessions/${v.id}/pause`);
  assert.equal(r.status, 400, r.body);
  assert.match(r.body, /The worktree folder is gone\. Resume recreates it from the branch, or Archive the session\./);
});

test('resume succeeds when the worktree folder was deleted by hand', async () => {
  const repo = makeRepo();
  const v = await create(repo, 'deleted then resumed');
  await h.exit(v.id);
  rmSync(v.workspace.worktree, { recursive: true, force: true });
  const r = await h.resumeAndWaitArgv(v.id);
  assert.equal(r.status, 200, r.body);
  assert.equal(readFileSync(join(v.workspace.worktree, 'README.md'), 'utf8'), 'hi\n');
  assert.equal(git(v.workspace.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), v.workspace.branch);
  await h.ready(v.id);
});
