import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinks, openable } from '../../ui/links.js';
import { filter, score } from '../../ui/palette.js';

test('URLs and loopback ports become links; trailing punctuation is not part of them', () => {
  const l = findLinks('See https://example.com/a?b=1. Dev server: localhost:5173/app, and http://127.0.0.1:8080');
  assert.deepEqual(l.map((x) => x.target), ['https://example.com/a?b=1', 'http://localhost:5173/app', 'http://127.0.0.1:8080']);
  assert.deepEqual(findLinks('no links here: example.com, ftp://x, :3000'), []);
});

test('only paths the session changed become file links', () => {
  const changed = ['src/checkout/address.ts', 'README.md'];
  const l = findLinks('Edited src/checkout/address.ts and ./README.md; read src/other.ts', changed);
  assert.deepEqual(l.map((x) => [x.kind, x.target]), [['file', 'src/checkout/address.ts'], ['file', 'README.md']]);
  assert.deepEqual(findLinks('src/checkout/address.ts', []), []);
});

test('only http(s) links ever open (OSC 8 too)', () => {
  assert.equal(openable('https://x.dev'), true);
  assert.equal(openable('javascript:alert(1)'), false);
  assert.equal(openable('file:///etc/passwd'), false);
});

test('fuzzy palette: in-order letters, word starts first', () => {
  assert.ok(score('chk', 'checkout-flow') > 0);
  assert.equal(score('xyz', 'checkout-flow'), -1);
  assert.ok(score('cf', 'checkout-flow') > score('cf', 'search-config'));
  const items = [{ id: 'a', label: 'New session', run: () => {} }, { id: 'b', label: 'checkout-flow', hint: 'web-app · Idle', run: () => {} }, { id: 'c', label: 'Show now', run: () => {} }];
  assert.deepEqual(filter(items, 'web').map((i) => i.id), ['b']);
  assert.deepEqual(filter(items, '').map((i) => i.id), ['a', 'b', 'c']);
  assert.deepEqual(filter(items, 'new').map((i) => i.id)[0], 'a');
});

test('terminal chords: ⌘⇧K / Ctrl⇧K palette, ⌘Esc leave; plain Esc and composing keys stay Claude\'s', async () => {
  const { termChord } = await import('../../ui/terminal.js');
  const k = (o: Record<string, unknown>) => ({ type: 'keydown', metaKey: false, ctrlKey: false, shiftKey: false, isComposing: false, keyCode: 0, repeat: false, key: '', code: '', ...o }) as unknown as KeyboardEvent;
  assert.equal(termChord(k({ metaKey: true, shiftKey: true, code: 'KeyK', key: 'K' })), 'palette');
  assert.equal(termChord(k({ ctrlKey: true, shiftKey: true, code: 'KeyK', key: 'K' })), 'palette');
  assert.equal(termChord(k({ metaKey: true, key: 'Escape' })), 'leave');
  assert.equal(termChord(k({ key: 'Escape' })), null, "Esc (and Esc twice) is Claude's");
  assert.equal(termChord(k({ metaKey: true, shiftKey: true, code: 'KeyK', isComposing: true })), null);
  assert.equal(termChord(k({ metaKey: true, key: 'Escape', repeat: true })), null);
  assert.equal(termChord(k({ metaKey: true, code: 'KeyK' })), null, "⌘K inside the terminal is Claude's");
});
