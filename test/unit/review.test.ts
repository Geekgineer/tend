import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeStats, checkRel, listTree, readText, resolveInside, ReviewError, textAt } from '../../src/review.ts';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

function repo(): { dir: string; base: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tend-review-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@example.com');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'README.md'), '# Hi\n');
  writeFileSync(join(dir, 'gone.txt'), 'bye\n');
  writeFileSync(join(dir, '.gitignore'), 'secret.env\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return { dir, base: git(dir, 'rev-parse', 'HEAD').trim() };
}

const rejects = async (p: Promise<unknown>, status: number) => {
  await assert.rejects(p, (e) => e instanceof ReviewError && e.status === status);
};

test('paths are plain segments: no climbing, no .git, nothing absolute', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', '.git/config', 'sub/.GIT/HEAD', 'a\0b', 'a\\b']) {
    assert.throws(() => checkRel(bad), ReviewError, JSON.stringify(bad));
  }
  assert.equal(checkRel('src/a.ts'), 'src/a.ts');
  assert.equal(checkRel('.github/workflows/ci.yml'), '.github/workflows/ci.yml');
  assert.equal(checkRel('a..b/c...d'), 'a..b/c...d');
});

test('a symlink can point inside the folder, never outside it', async () => {
  const { dir } = repo();
  const outside = mkdtempSync(join(tmpdir(), 'tend-outside-'));
  writeFileSync(join(outside, 'secret'), 'nope');
  symlinkSync(join(outside, 'secret'), join(dir, 'leak'));
  symlinkSync(join(dir, 'src'), join(dir, 'srclink'));
  symlinkSync('src/a.ts', join(dir, 'alias.ts'));
  await rejects(resolveInside(dir, 'leak'), 404);
  await rejects(resolveInside(dir, 'src'), 404); // a folder is not a file
  await rejects(resolveInside(dir, 'nope.txt'), 404);
  assert.equal((await resolveInside(dir, 'alias.ts')).abs, join(dir, 'src', 'a.ts'));
  assert.equal((await resolveInside(dir, 'srclink/a.ts')).abs, join(dir, 'src', 'a.ts'));
});

test('the tree is tracked + untracked files, minus ignored and .tend', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'new.ts'), 'x\n');
  writeFileSync(join(dir, 'secret.env'), 'KEY=1\n');
  mkdirSync(join(dir, '.tend', 'attachments'), { recursive: true });
  writeFileSync(join(dir, '.tend', 'attachments', 'p.png'), 'x');
  const { files, truncated } = await listTree(dir, true);
  assert.deepEqual(files, ['.gitignore', 'README.md', 'gone.txt', 'new.ts', 'src/a.ts']);
  assert.equal(truncated, false);
});

test('outside git the tree is a walk that skips heavy folders and never follows linked folders', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tend-plain-')));
  mkdirSync(join(dir, 'notes'));
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'a.md'), '# a');
  writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), '');
  writeFileSync(join(dir, 'top.txt'), '');
  symlinkSync('/', join(dir, 'root'));
  const { files } = await listTree(dir, false);
  assert.deepEqual(files, ['notes/a.md', 'root', 'top.txt']); // the link is listed; opening it is refused
  await rejects(resolveInside(dir, 'root'), 404);
});

test('change stats: modified with line counts, new, deleted; the fingerprint moves with the file', async () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'src', 'a.ts'), 'one\nTWO\nthree\nfour\n');
  writeFileSync(join(dir, 'fresh.md'), 'a\nb\n');
  unlinkSync(join(dir, 'gone.txt'));
  const stats = await changeStats(dir, base, ['fresh.md', 'gone.txt', 'src/a.ts']);
  const by = Object.fromEntries(stats.map((s) => [s.path, s]));
  assert.deepEqual({ ...by['src/a.ts'], fp: undefined }, { path: 'src/a.ts', status: 'M', add: 2, del: 1, fp: undefined });
  assert.deepEqual({ ...by['fresh.md'], fp: undefined }, { path: 'fresh.md', status: 'A', add: 2, del: 0, fp: undefined });
  assert.equal(by['gone.txt']!.status, 'D');
  assert.equal(by['gone.txt']!.fp, 'gone');
  const before = by['src/a.ts']!.fp;
  writeFileSync(join(dir, 'src', 'a.ts'), 'changed again, longer\n');
  const [after] = await changeStats(dir, base, ['src/a.ts']);
  assert.notEqual(after!.fp, before);
});

test('text at the session start: the old version, or null for a new file; revisions are checked', async () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'README.md'), '# Changed\n');
  assert.deepEqual(await textAt(dir, base, 'README.md'), { text: '# Hi\n', binary: false, truncated: false });
  assert.equal(await textAt(dir, base, 'never.md'), null);
  await assert.rejects(textAt(dir, '--output=/tmp/x', 'README.md'), ReviewError);
  await assert.rejects(textAt(dir, base, '../x'), ReviewError);
});

test('binary files are flagged, big files are capped', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'b.bin'), Buffer.from([1, 0, 2]));
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(5000));
  assert.equal((await readText(join(dir, 'b.bin'))).binary, true);
  const big = await readText(join(dir, 'big.txt'), 1000);
  assert.equal(big.text.length, 1000);
  assert.equal(big.truncated, true);
});
