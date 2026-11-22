import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, changedBlocks, compact, extClass, inlineRange, langOf, parseDiff, reviewMessage, splitHighlighted, splitRows } from '../../ui/review-model.js';

const DIFF = `diff --git a/x.ts b/x.ts
index 1..2 100644
--- a/x.ts
+++ b/x.ts
@@ -1,4 +1,5 @@ function top
 keep
-old one
-old two
+new one
+new two
+new three
 tail
@@ -10,2 +11,2 @@
-a
+b
 c
`;

test('a unified diff becomes hunks with old and new line numbers', () => {
  const [h1, h2] = parseDiff(DIFF);
  assert.equal(h1!.header, '@@ -1,4 +1,5 @@ function top');
  assert.deepEqual(h1!.lines.map((l) => [l.kind, l.old, l.new, l.text]), [
    [' ', 1, 1, 'keep'],
    ['-', 2, null, 'old one'],
    ['-', 3, null, 'old two'],
    ['+', null, 2, 'new one'],
    ['+', null, 3, 'new two'],
    ['+', null, 4, 'new three'],
    [' ', 4, 5, 'tail'],
  ]);
  assert.deepEqual(h2!.lines.map((l) => [l.kind, l.old, l.new]), [['-', 10, null], ['+', null, 11], [' ', 11, 12]]);
});

test('an untracked file (no hunk header) is all added, with no empty last line', () => {
  const [h] = parseDiff('new file notes.md\n+# Notes\n+\n+one\n+');
  assert.deepEqual(h!.lines.map((l) => [l.kind, l.new, l.text]), [['+', 1, '# Notes'], ['+', 2, ''], ['+', 3, 'one']]);
});

test('side by side: removals face additions, extra lines face nothing', () => {
  const rows = splitRows(parseDiff(DIFF)[0]!);
  assert.deepEqual(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [
    ['keep', 'keep'],
    ['old one', 'new one'],
    ['old two', 'new two'],
    [null, 'new three'],
    ['tail', 'tail'],
  ]);
});

test('word marks: the changed middle of similar lines, nothing for unrelated ones', () => {
  assert.deepEqual(inlineRange('return lines.length;', 'return lines.reduce(f, 0);'), { a: [13, 19], b: [13, 25] });
  assert.equal(inlineRange('  }', '  return Math.max(0, x);'), null, 'shared indentation alone is not similarity');
  assert.equal(inlineRange('abc', 'xyz'), null);
});

test('the tree nests folders first, counts files, keeps deleted files and folds single-folder chains', () => {
  const t = buildTree(['README.md', 'src/a/b/c.ts', 'src/z.ts'], [{ path: 'src/gone.ts', status: 'D', add: null, del: 3, fp: 'gone' }]);
  assert.deepEqual(t.children.map((c) => c.name), ['src', 'README.md']);
  const src = t.children[0]!;
  assert.equal(src.files, 3);
  assert.deepEqual(src.children.map((c) => c.name), ['a', 'gone.ts', 'z.ts']);
  assert.equal(src.children[1]!.change?.status, 'D');
  const folded = compact(t);
  assert.equal(folded.children[0]!.children[0]!.name, 'a/b');
  assert.equal(folded.children[0]!.children[0]!.path, 'src/a/b');
});

test('changed Markdown blocks: only new or edited blocks are marked', () => {
  assert.deepEqual(changedBlocks(['# T', 'para', 'list'], ['# T', 'para edited', 'list', 'new']), [false, true, false, true]);
  assert.deepEqual(changedBlocks([], ['a', 'b']), [true, true]);
  assert.equal(changedBlocks(['a', 'b'], ['b', 'a']).filter(Boolean).length, 1, 'a swap marks one block as moved');
});

test('the review message lists comments per file in line order, on one line each', () => {
  const msg = reviewMessage([
    { path: 'b.ts', line: 9, side: 'new', code: 'x()', text: 'second' },
    { path: 'a.ts', line: 3, side: 'new', code: '  const y = 1;  ', text: 'multi\n  line' },
    { path: 'b.ts', line: 2, side: 'old', code: '', text: 'why remove?' },
  ]);
  assert.equal(msg, [
    'Review comments on your changes. Please address each one:',
    '- b.ts (removed line 2): why remove?',
    '- b.ts:9 `x()`: second',
    '- a.ts:3 `const y = 1;`: multi line',
  ].join('\n'));
});

test('the review message carries no control characters (it is one bracketed paste)', () => {
  const msg = reviewMessage([{ path: 'x.ts', line: 1, side: 'new', code: 'a\x1b[201~\rrm -rf /', text: 'b\x07c' }]);
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(msg), JSON.stringify(msg));
  assert.match(msg, /x\.ts:1 `a \[201~ rm -rf \/`: b c/);
});

test('highlighted HTML splits into self-contained lines (multi-line spans reopen)', () => {
  const lines = splitHighlighted('<span class="c">/* a\nb */</span> x\n<span class="k">y</span>');
  assert.deepEqual(lines, ['<span class="c">/* a</span>', '<span class="c">b */</span> x', '<span class="k">y</span>']);
});

test('languages and type dots by file name', () => {
  assert.equal(langOf('src/a.mts'), 'typescript');
  assert.equal(langOf('Dockerfile'), 'dockerfile');
  assert.equal(langOf('LICENSE'), '');
  assert.equal(extClass('notes.MD'), 'md');
  assert.equal(extClass('a.png'), 'img');
});
