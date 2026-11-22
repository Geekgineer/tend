import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWorktree, branchExists, branchName, deleteBranch, facts, ignoredEntries, reAddWorktree,
  readArgs, removeWorktree, repoInfo, restoreWip, wipCommit, worktreeOn,
} from '../../src/git.ts';

const roots: string[] = [];
const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tmpRoot = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tend-git-')));
  roots.push(root);
  return root;
};
const initRepo = (commit = true): { root: string; repo: string } => {
  const root = tmpRoot();
  const repo = join(root, 'my #repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  if (commit) {
    writeFileSync(join(repo, 'README.md'), 'hi\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
  }
  return { root, repo };
};

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test('readArgs starts with --no-optional-locks, then turns off fsmonitor and repo hooks', () => {
  assert.deepEqual(readArgs('/x', ['status']), [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', '/x', 'status',
  ]);
});

test("Tend's git calls never run the repo's hooks (post-checkout on addWorktree, post-commit on wipCommit)", () => {
  const { root, repo } = initRepo();
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const name of ['post-checkout', 'post-commit']) {
    writeFileSync(join(hooks, name), `#!/bin/sh\ntouch '${join(root, `ran-${name}`)}'\n`, { mode: 0o755 });
  }
  const wt = join(root, 'wt');
  addWorktree(repo, wt, 'tend/h-1', 'main');
  writeFileSync(join(wt, 'n.txt'), 'n');
  assert.ok(wipCommit(wt));
  assert.equal(existsSync(join(root, 'ran-post-checkout')), false, 'post-checkout ran');
  assert.equal(existsSync(join(root, 'ran-post-commit')), false, 'post-commit ran');
  // the hooks themselves work: git run by hand fires them
  git(wt, 'commit', '-q', '--allow-empty', '-m', 'by hand');
  assert.equal(existsSync(join(root, 'ran-post-commit')), true);
});

test('repoInfo: null outside git, head null when unborn, dirty after untracked file', () => {
  assert.equal(repoInfo(tmpRoot()), null);
  const { repo } = initRepo(false);
  const unborn = repoInfo(repo);
  assert.ok(unborn);
  assert.equal(unborn.head, null);
  assert.equal(unborn.dirty, false);
  assert.equal(unborn.top, realpathSync(repo));
  const r2 = initRepo().repo;
  const clean = repoInfo(r2);
  assert.match(clean?.head ?? '', /^[0-9a-f]{40}$/);
  assert.equal(clean?.dirty, false);
  writeFileSync(join(r2, 'u.txt'), 'x');
  assert.equal(repoInfo(r2)?.dirty, true);
});

test('repoInfo from a subfolder and a linked worktree share commonDir', () => {
  const { root, repo } = initRepo();
  mkdirSync(join(repo, 'sub'));
  const wt = join(root, 'wt');
  addWorktree(repo, wt, 'tend/x-1', 'main');
  const a = repoInfo(repo);
  const b = repoInfo(join(repo, 'sub'));
  const c = repoInfo(wt);
  assert.ok(a && b && c);
  assert.equal(b.commonDir, a.commonDir);
  assert.equal(c.commonDir, a.commonDir);
  assert.equal(b.top, a.top);
  assert.equal(c.top, realpathSync(wt));
});

test('branchName slug rules', () => {
  const id = 'ab12cd34';
  assert.equal(branchName('Fix: Login #2;', id), 'tend/fix-login-2-ab12cd34');
  assert.equal(branchName('--force', id), 'tend/force-' + id);
  assert.equal(branchName('日本', id), 'tend/session-' + id);
  const long = branchName('a'.repeat(100), id);
  assert.equal(long, 'tend/' + 'a'.repeat(40) + '-' + id);
  assert.ok(long.slice(5, -(id.length + 1)).length <= 40);
});

test('addWorktree creates the branch at base; facts track commits and changes', async () => {
  const { root, repo } = initRepo();
  const wt = join(root, 'wt');
  addWorktree(repo, wt, 'tend/x-1', 'main');
  const mainSha = git(repo, 'rev-parse', 'main').trim();
  assert.equal(branchExists(repo, 'tend/x-1'), true);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  writeFileSync(join(wt, 'a.txt'), 'a');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'a');
  let f = await facts(wt, mainSha);
  assert.equal(f.branch, 'tend/x-1');
  assert.equal(f.commits, 1);
  assert.deepEqual(f.changed, ['a.txt']);
  assert.equal(f.uncommitted, 0);
  writeFileSync(join(wt, 'b.txt'), 'b');
  f = await facts(wt, mainSha);
  assert.equal(f.uncommitted, 1);
  assert.deepEqual(f.changed, ['a.txt', 'b.txt']);
  assert.equal(f.ahead, null);
  assert.equal(f.behind, null);
});

test('facts in place (base null): changed = uncommitted paths; commits 0; .tend excluded', async () => {
  const { repo } = initRepo();
  writeFileSync(join(repo, 'README.md'), 'changed\n');
  writeFileSync(join(repo, 'new file.txt'), 'n');
  mkdirSync(join(repo, '.tend'));
  writeFileSync(join(repo, '.tend', 'x'), 'x');
  const f = await facts(repo, null);
  assert.equal(f.commits, 0);
  assert.equal(f.uncommitted, 2);
  assert.deepEqual(f.changed, ['README.md', 'new file.txt']);
});

test('facts ignores .tend, lists untracked dir files, rejects bad base, no-renames diff', async () => {
  const { root, repo } = initRepo();
  const wt = join(root, 'wt');
  addWorktree(repo, wt, 'tend/f-1', 'main');
  const sha = git(repo, 'rev-parse', 'main').trim();
  mkdirSync(join(wt, '.tend'));
  writeFileSync(join(wt, '.tend', 'x'), 'x');
  let f = await facts(wt, sha);
  assert.equal(f.uncommitted, 0);
  assert.deepEqual(f.changed, []);
  mkdirSync(join(wt, 'out'));
  writeFileSync(join(wt, 'out', 'x.txt'), 'x');
  f = await facts(wt, sha);
  assert.deepEqual(f.changed, ['out/x.txt']);
  rmSync(join(wt, 'out'), { recursive: true });
  git(wt, 'mv', 'README.md', 'MOVED.md');
  git(wt, 'commit', '-q', '-m', 'mv');
  f = await facts(wt, sha);
  assert.deepEqual(f.changed, ['MOVED.md', 'README.md']);
  await assert.rejects(facts(wt, '--output=/tmp/x'), /invalid base/);
  await assert.rejects(facts(wt, 'main'), /invalid base/);
});

test('facts counts a staged rename once and lists both paths', async () => {
  const { repo } = initRepo();
  git(repo, 'mv', 'README.md', 'RENAMED.md');
  const f = await facts(repo, null);
  assert.equal(f.uncommitted, 1);
  assert.deepEqual(f.changed, ['README.md', 'RENAMED.md']);
});

test('facts reports ahead/behind with an upstream', async () => {
  const { root, repo } = initRepo();
  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '-q', repo, clone]);
  git(clone, 'config', 'user.name', 'T');
  git(clone, 'config', 'user.email', 't@example.com');
  writeFileSync(join(clone, 'c.txt'), 'c');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'c');
  const f = await facts(clone, null);
  assert.equal(f.ahead, 1);
  assert.equal(f.behind, 0);
});

test('wipCommit on a clean tree returns null and makes no commit', () => {
  const { repo } = initRepo();
  const before = git(repo, 'rev-parse', 'HEAD');
  assert.equal(wipCommit(repo), null);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
});

test('wipCommit + removeWorktree + reAddWorktree + restoreWip restores files byte-for-byte', () => {
  const { root, repo } = initRepo();
  writeFileSync(join(repo, 'del.txt'), 'gone');
  writeFileSync(join(repo, 'mod.bin'), Buffer.from([1, 2, 3]));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'more');
  const wt = join(root, 'wt');
  addWorktree(repo, wt, 'tend/p-1', 'main');
  const mod = Buffer.from([9, 0, 255, 10, 13, 7]);
  writeFileSync(join(wt, 'mod.bin'), mod);
  mkdirSync(join(wt, 'out'));
  writeFileSync(join(wt, 'out', 'x.txt'), 'built\r\n');
  rmSync(join(wt, 'del.txt'));
  const wip = wipCommit(wt);
  assert.ok(wip);
  removeWorktree(repo, wt);
  assert.equal(existsSync(wt), false);
  assert.equal(worktreeOn(repo, wt, 'tend/p-1'), false);
  reAddWorktree(repo, wt, 'tend/p-1');
  assert.equal(worktreeOn(repo, wt, 'tend/p-1'), true);
  assert.equal(restoreWip(wt, wip), true);
  assert.deepEqual(readFileSync(join(wt, 'mod.bin')), mod);
  assert.equal(readFileSync(join(wt, 'out', 'x.txt'), 'utf8'), 'built\r\n');
  assert.equal(existsSync(join(wt, 'del.txt')), false);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  assert.match(git(wt, 'status', '--porcelain'), /\?\? out\//);
});

test('restoreWip returns false and changes nothing when HEAD is not the wip sha', () => {
  const { repo } = initRepo();
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(repo, 'k.txt'), 'k');
  assert.equal(restoreWip(repo, 'deadbeef'), false);
  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(readFileSync(join(repo, 'k.txt'), 'utf8'), 'k');
});

test('ignoredEntries lists top-most ignored entries, .tend included (it is set aside on pause too)', () => {
  const { repo } = initRepo();
  writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n.tend/\n');
  mkdirSync(join(repo, 'node_modules', 'a'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'a', 'b'), 'x');
  writeFileSync(join(repo, '.env'), 'S=1');
  mkdirSync(join(repo, '.tend'));
  writeFileSync(join(repo, '.tend', 'y'), 'y');
  assert.deepEqual(ignoredEntries(repo).sort(), ['.env', '.tend', 'node_modules']);
});

test('a cache folder that ignores itself (mypy, pytest, ruff) is listed once, not with its insides', () => {
  const { repo } = initRepo();
  // what `mypy` leaves behind: no entry in the repo's .gitignore, a "*" .gitignore of its own inside
  mkdirSync(join(repo, '.mypy_cache', '3.14'), { recursive: true });
  writeFileSync(join(repo, '.mypy_cache', '.gitignore'), '# Automatically created by mypy\n*\n');
  writeFileSync(join(repo, '.mypy_cache', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  writeFileSync(join(repo, '.mypy_cache', '3.14', 'x.json'), '{}');
  mkdirSync(join(repo, '.pytest_cache', 'v'), { recursive: true });
  writeFileSync(join(repo, '.pytest_cache', '.gitignore'), '*\n');
  writeFileSync(join(repo, '.pytest_cache', 'v', 'y'), 'y');
  assert.deepEqual(ignoredEntries(repo).sort(), ['.mypy_cache', '.pytest_cache']);
});

test('removeWorktree throws and keeps the worktree when locked', () => {
  const { root, repo } = initRepo();
  const wt = join(root, 'wt');
  addWorktree(repo, wt, 'tend/l-1', 'main');
  git(repo, 'worktree', 'lock', wt);
  assert.throws(() => removeWorktree(repo, wt), (e: Error) => e.message.length > 0 && !e.message.includes('\n'));
  assert.equal(existsSync(wt), true);
  assert.equal(worktreeOn(repo, wt, 'tend/l-1'), true);
});

test('removeWorktree refuses when a tracked file is modified', () => {
  const { root, repo } = initRepo();
  const wt = join(root, 'wt');
  addWorktree(repo, wt, 'tend/m-1', 'main');
  writeFileSync(join(wt, 'README.md'), 'edited\n');
  assert.throws(() => removeWorktree(repo, wt));
  assert.equal(readFileSync(join(wt, 'README.md'), 'utf8'), 'edited\n');
});

test('branchExists / deleteBranch', () => {
  const { repo } = initRepo();
  git(repo, 'branch', 'tend/z-1');
  assert.equal(branchExists(repo, 'tend/z-1'), true);
  deleteBranch(repo, 'tend/z-1');
  assert.equal(branchExists(repo, 'tend/z-1'), false);
});

test('lock contention: 200 facts() concurrent with 50 commits produce zero commit errors', async () => {
  const { repo } = initRepo();
  let next = 0;
  const readers = Array.from({ length: 16 }, async () => {
    while (next < 200) {
      next++;
      await facts(repo, null);
    }
  });
  let errors = 0;
  for (let i = 0; i < 50; i++) {
    try {
      writeFileSync(join(repo, `f${i}.txt`), String(i));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', `c${i}`);
    } catch {
      errors++;
    }
    await sleep(1);
  }
  await Promise.all(readers);
  assert.equal(errors, 0);
  assert.equal(next, 200);
});
