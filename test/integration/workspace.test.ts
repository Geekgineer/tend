import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserError } from '../../src/errors.ts';
import { hasTranscript, pauseWorkspace, prepareWorkspace } from '../../src/workspace.ts';

const roots: string[] = [];
const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tmpRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'tend-ws-'));
  roots.push(root);
  return root;
};
function initRepo(commit = true): { repo: string; home: string } {
  const root = tmpRoot();
  const repo = join(root, 'my #repo');
  mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  if (commit) {
    writeFileSync(join(repo, 'packages', 'api', 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'one');
  }
  const home = join(root, 'home');
  mkdirSync(home);
  return { repo, home };
}

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test('prepareWorkspace in a git repo creates <realpath home>/worktrees/<id> on tend/<slug>-<id> at HEAD with subdir preserved', () => {
  const { repo, home } = initRepo();
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const r = prepareWorkspace({ cwd: join(repo, 'packages', 'api'), id: 'ab12cd34', name: 'My Task', home: realpathSync(home), isolate: true });
  assert.equal(r.warning, undefined);
  const ws = r.workspace;
  assert.equal(ws.mode, 'worktree');
  if (ws.mode !== 'worktree') return;
  assert.equal(ws.worktree, join(realpathSync(home), 'worktrees', 'ab12cd34'));
  assert.equal(ws.branch, 'tend/my-task-ab12cd34');
  assert.equal(ws.base, head);
  assert.equal(ws.repo, realpathSync(repo));
  assert.equal(ws.commonDir, realpathSync(join(repo, '.git')));
  assert.equal(ws.subdir, 'packages/api');
  assert.equal(ws.wip, null);
  assert.ok(r.launchCwd.endsWith('/packages/api'));
  assert.ok(statSync(r.launchCwd).isDirectory());
  assert.equal(git(ws.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), ws.branch);
  assert.equal(statSync(join(realpathSync(home), 'worktrees')).mode & 0o777, 0o700);
});

test('a dirty checkout still gets a worktree, with a warning naming the repo folder', () => {
  const { repo, home } = initRepo();
  writeFileSync(join(repo, 'dirty.txt'), 'x\n');
  const r = prepareWorkspace({ cwd: repo, id: 'aaaa0001', name: 'd', home: realpathSync(home), isolate: true });
  assert.equal(r.workspace.mode, 'worktree');
  assert.equal(r.warning, "Uncommitted changes in my #repo aren't included in the worktree.");
});

test('an unborn repo runs in place with a warning', () => {
  const { repo, home } = initRepo(false);
  const r = prepareWorkspace({ cwd: repo, id: 'aaaa0002', name: 'u', home, isolate: true });
  assert.deepEqual(r.workspace, { mode: 'inplace', top: realpathSync(repo) });
  assert.equal(r.launchCwd, repo);
  assert.equal(r.warning, 'This repo has no commits yet, so the session runs in the folder itself.');
});

test('a non-git folder runs in place without a warning, and isolate:false forces in place', () => {
  const root = tmpRoot();
  const plain = prepareWorkspace({ cwd: root, id: 'aaaa0003', name: 'p', home: root, isolate: true });
  assert.deepEqual(plain.workspace, { mode: 'inplace' });
  assert.equal(plain.warning, undefined);
  const { repo, home } = initRepo();
  const off = prepareWorkspace({ cwd: join(repo, 'packages'), id: 'aaaa0004', name: 'o', home, isolate: false });
  assert.deepEqual(off.workspace, { mode: 'inplace', top: realpathSync(repo) }, 'an in-place git session records the repo top');
  assert.equal(off.launchCwd, join(repo, 'packages'));
  assert.equal(off.warning, undefined);
});

test('two sessions with the same name from one repo get distinct branches and both worktrees exist', () => {
  const { repo, home } = initRepo();
  const a = prepareWorkspace({ cwd: repo, id: 'aaaa0005', name: 'same', home: realpathSync(home), isolate: true });
  const b = prepareWorkspace({ cwd: repo, id: 'bbbb0006', name: 'same', home: realpathSync(home), isolate: true });
  if (a.workspace.mode !== 'worktree' || b.workspace.mode !== 'worktree') return assert.fail('expected worktrees');
  assert.notEqual(a.workspace.branch, b.workspace.branch);
  assert.ok(existsSync(a.workspace.worktree) && existsSync(b.workspace.worktree));
});

test('hasTranscript finds <CLAUDE_CONFIG_DIR>/projects/x/U.jsonl', () => {
  const dir = tmpRoot();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.equal(hasTranscript('U-1'), false, 'no projects dir');
    mkdirSync(join(dir, 'projects', 'x'), { recursive: true });
    assert.equal(hasTranscript('U-1'), false);
    writeFileSync(join(dir, 'projects', 'x', 'U-1.jsonl'), '{}\n');
    assert.equal(hasTranscript('U-1'), true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('an untracked subfolder still gets a matching launch dir in the worktree', () => {
  const { repo, home } = initRepo();
  mkdirSync(join(repo, 'scratch'));
  const r = prepareWorkspace({ cwd: join(repo, 'scratch'), id: 'aaaa0007', name: 's', home: realpathSync(home), isolate: true });
  assert.ok(r.launchCwd.endsWith('/scratch'));
  assert.ok(statSync(r.launchCwd).isDirectory());
  assert.ok(r.launchCwd.startsWith(join(realpathSync(home), 'worktrees', 'aaaa0007')));
});

test('a worktree failure is a UserError and leaves an existing branch alone', () => {
  const { repo, home } = initRepo();
  writeFileSync(join(home, 'worktrees'), 'in the way');
  assert.throws(
    () => prepareWorkspace({ cwd: repo, id: 'aaaa0008', name: 'x', home: realpathSync(home), isolate: true }),
    (e) => e instanceof UserError && /^Could not create the worktree: /.test(e.message),
  );
  rmSync(join(home, 'worktrees'));
  git(repo, 'branch', 'tend/x-aaaa0009');
  assert.throws(
    () => prepareWorkspace({ cwd: repo, id: 'aaaa0009', name: 'x', home: realpathSync(home), isolate: true }),
    (e) => e instanceof UserError && /^Could not create the worktree: /.test(e.message),
  );
  assert.ok(git(repo, 'branch', '--list', 'tend/x-aaaa0009').includes('tend/x-aaaa0009'));
});

for (const late of [{ file: 'late.txt', what: 'an untracked file' }, { file: 'late.log', what: 'an ignored file' }]) {
  test(`${late.what} appearing while pause sets files aside aborts the pause and undoes it`, () => {
    const { repo, home } = initRepo();
    writeFileSync(join(repo, '.gitignore'), '.env\n*.log\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'ignore');
    const r = prepareWorkspace({ cwd: repo, id: 'aaaa0010', name: 'w', home: realpathSync(home), isolate: true });
    if (r.workspace.mode !== 'worktree') return assert.fail('expected a worktree');
    const ws = r.workspace;
    writeFileSync(join(ws.worktree, '.env'), 'E=1\n');
    writeFileSync(join(ws.worktree, 'packages', 'api', 'a.txt'), 'edited\n');
    const stash = join(realpathSync(home), 'paused', 'aaaa0010');
    assert.throws(
      () => pauseWorkspace(ws, stash, { afterMove: () => writeFileSync(join(ws.worktree, late.file), 'still writing\n') }),
      (e) => e instanceof UserError && e.message === 'Something is still writing in the worktree (a dev server?). Stop it and pause again.',
    );
    assert.ok(existsSync(ws.worktree));
    assert.equal(git(ws.worktree, 'rev-parse', 'HEAD').trim(), ws.base, 'WIP commit undone');
    assert.equal(readFileSync(join(ws.worktree, '.env'), 'utf8'), 'E=1\n', 'set-aside file moved back');
    assert.equal(readFileSync(join(ws.worktree, 'packages', 'api', 'a.txt'), 'utf8'), 'edited\n');
    assert.equal(readFileSync(join(ws.worktree, late.file), 'utf8'), 'still writing\n');
    assert.equal(existsSync(stash), false);
  });
}
