import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStuckWatch, normalise, REPEAT_WINDOW, SILENT } from '../../src/stuck.ts';

const fail = (error: string, extra: Record<string, unknown> = {}) => ({ error, is_interrupt: false, ...extra });

test('three of the same failure within 15 min is stuck; the error is kept verbatim', () => {
  const w = createStuckWatch();
  const e1 = 'Error: Cannot find module /w/src/a.ts (line 12)';
  const e2 = 'Error: Cannot find module /w/src/b.ts (line 40)';
  assert.equal(w.onEvent('s', 'PostToolUseFailure', 'Bash', fail(e1), 0), undefined);
  assert.equal(w.onEvent('s', 'PostToolUseFailure', 'Read', fail(e1), 1), undefined, 'another tool');
  assert.equal(w.onEvent('s', 'PostToolUseFailure', 'Bash', fail(e2), 2), undefined);
  const s = w.onEvent('s', 'PostToolUseFailure', 'Bash', fail(e1), 3);
  assert.deepEqual(s, { reason: 'repeating', tool: 'Bash', error: e1, count: 3, since: 0 });
});

test('failures outside the window, interrupts and successes reset the count', () => {
  const w = createStuckWatch();
  w.onEvent('s', 'PostToolUseFailure', 'Bash', fail('boom'), 0);
  w.onEvent('s', 'PostToolUseFailure', 'Bash', fail('boom'), 1);
  assert.equal(w.onEvent('s', 'PostToolUseFailure', 'Bash', fail('boom'), REPEAT_WINDOW + 5), undefined, 'the first two are too old');
  assert.equal(w.onEvent('s', 'PostToolUseFailure', 'Bash', fail('boom', { is_interrupt: 'True' }), REPEAT_WINDOW + 6), undefined);
  assert.equal(w.onEvent('s', 'PostToolUse', 'Bash', {}, REPEAT_WINDOW + 7), null, 'a success clears');
  assert.equal(w.onEvent('s', 'PostToolUseFailure', 'Bash', fail('boom'), REPEAT_WINDOW + 8), undefined);
});

test('silent for 10 min while working', () => {
  const w = createStuckWatch();
  assert.equal(w.silent(true, 0, SILENT - 1), null);
  assert.deepEqual(w.silent(true, 0, SILENT), { reason: 'silent', since: 0 });
  assert.equal(w.silent(false, 0, SILENT * 3), null);
});

test('normalise drops paths, ids, numbers and quoted parts', () => {
  assert.equal(normalise('ENOENT: no such file "/a/b c.txt" at 0x1f2e3d4c5b, line 12'), normalise("ENOENT: no such file '/x/y.txt' at 0xdeadbeef00, line 99"));
});
