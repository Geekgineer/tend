import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOverlaps, newPairs } from '../../src/overlap.ts';

test('two sessions sharing a.ts both overlap, each listing the other', () => {
  const m = computeOverlaps([
    { id: 'a', commonDir: '/r', changed: ['b.ts', 'a.ts'] },
    { id: 'b', commonDir: '/r', changed: ['a.ts', 'c.ts'] },
  ]);
  assert.deepEqual(m.get('a'), { files: ['a.ts'], with: ['b'] });
  assert.deepEqual(m.get('b'), { files: ['a.ts'], with: ['a'] });
});

test('different commonDir never overlap', () => {
  const m = computeOverlaps([
    { id: 'a', commonDir: '/r1', changed: ['a.ts'] },
    { id: 'b', commonDir: '/r2', changed: ['a.ts'] },
  ]);
  assert.equal(m.size, 0);
});

test('no shared files → no entry', () => {
  const m = computeOverlaps([
    { id: 'a', commonDir: '/r', changed: ['a.ts'] },
    { id: 'b', commonDir: '/r', changed: ['b.ts'] },
  ]);
  assert.equal(m.size, 0);
});

test('three sessions: with lists both others', () => {
  const m = computeOverlaps([
    { id: 'c', commonDir: '/r', changed: ['x.ts'] },
    { id: 'a', commonDir: '/r', changed: ['x.ts', 'y.ts'] },
    { id: 'b', commonDir: '/r', changed: ['x.ts', 'y.ts'] },
  ]);
  assert.deepEqual(m.get('a'), { files: ['x.ts', 'y.ts'], with: ['b', 'c'] });
  assert.deepEqual(m.get('c'), { files: ['x.ts'], with: ['a', 'b'] });
});

test('newPairs reports a pair once and not again when unchanged', () => {
  const items = [
    { id: 'a', commonDir: '/r', changed: ['x.ts'] },
    { id: 'b', commonDir: '/r', changed: ['x.ts'] },
  ];
  const first = computeOverlaps(items);
  assert.deepEqual(newPairs(new Map(), first), [['a', 'b', ['x.ts']]]);
  assert.deepEqual(newPairs(first, computeOverlaps(items)), []);
});

test('newPairs lists only the files a pair shares, even when one of them shares other files with a third', () => {
  const next = computeOverlaps([
    { id: 'a', commonDir: '/r', changed: ['ab.ts', 'ac.ts'] },
    { id: 'b', commonDir: '/r', changed: ['ab.ts'] },
    { id: 'c', commonDir: '/r', changed: ['ac.ts'] },
  ]);
  assert.deepEqual(newPairs(new Map(), next), [['a', 'b', ['ab.ts']], ['a', 'c', ['ac.ts']]]);
});
