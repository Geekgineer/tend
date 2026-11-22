import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOutput } from '../../src/control-mode.ts';

test('decodes octal escapes and plain bytes', () => {
  const r = decodeOutput('%output %3 a\\033[1mb\\134c');
  assert.ok(r);
  assert.equal(r.pane, '%3');
  assert.deepEqual([...r.bytes], [0x61, 0x1b, 0x5b, 0x31, 0x6d, 0x62, 0x5c, 0x63]);
});

test('non-output lines are null', () => {
  assert.equal(decodeOutput('%begin 1 2 0'), null);
  assert.equal(decodeOutput('%window-add @1'), null);
  assert.equal(decodeOutput(''), null);
});

test('emoji split across two lines reassembles to exact utf-8 bytes', () => {
  const want = Buffer.from('😀', 'utf8');
  // the control-mode stream is read as latin1: each utf-8 byte is one char; tmux escapes only < 0x20 and '\'
  const l = want.toString('latin1');
  const a = decodeOutput(`%output %1 ${l.slice(0, 2)}`);
  const b = decodeOutput(`%output %1 ${l.slice(2)}`);
  assert.ok(a && b);
  assert.deepEqual(Buffer.concat([a.bytes, b.bytes]), want);
});

test('70 KB line decodes to its exact length', () => {
  const r = decodeOutput('%output %1 ' + 'x'.repeat(70 * 1024));
  assert.ok(r);
  assert.equal(r.bytes.length, 70 * 1024);
});
