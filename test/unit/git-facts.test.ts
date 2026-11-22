import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capChanged, MAX_CHANGED } from '../../src/git.ts';

test('changed is capped at 500 paths with changedTruncated set; at or under the cap nothing is added', () => {
  assert.equal(MAX_CHANGED, 500);
  const many = Array.from({ length: 501 }, (_, i) => `f${String(i).padStart(4, '0')}`);
  assert.deepEqual(capChanged(many), { changed: many.slice(0, 500), changedTruncated: true });
  assert.deepEqual(capChanged(many.slice(0, 500)), { changed: many.slice(0, 500) });
  assert.deepEqual(capChanged([]), { changed: [] });
});
