import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesOf, nameFor, takesPaste } from '../../ui/media.js';

test('pasted images without a name get a dated screenshot name', () => {
  const d = new Date(Date.UTC(2026, 9, 29, 14, 52, 7));
  assert.equal(nameFor({ name: 'image.png', type: 'image/png' } as File, d), 'screenshot-2026-10-29-14-52-07.png');
  assert.equal(nameFor({ name: '', type: 'image/jpeg' } as File, d), 'screenshot-2026-10-29-14-52-07.jpg');
  assert.equal(nameFor({ name: 'spec.pdf', type: 'application/pdf' } as File, d), 'spec.pdf');
});

test('files come from dt.files, or else file items (clipboard images)', () => {
  const f = { name: 'a.png' } as File;
  assert.deepEqual(filesOf({ files: [f], items: [] } as unknown as DataTransfer), [f]);
  assert.deepEqual(filesOf({ files: [], items: [{ kind: 'file', getAsFile: () => f }, { kind: 'string' }] } as unknown as DataTransfer), [f]);
  assert.deepEqual(filesOf(null), []);
});

test('pastes: files only, never into text fields, and not text with a picture of itself', () => {
  const f = { name: 'a.png' } as File;
  const dt = (types: string[], files: File[], items: unknown[] = []) => ({ types, files, items }) as unknown as DataTransfer;
  const el = (cls: string, field: boolean) => ({ classList: { contains: (c: string) => c === cls }, closest: () => (field ? {} : null) }) as unknown as Element;
  assert.equal(takesPaste(dt(['Files'], [f]), null), true);
  assert.equal(takesPaste(dt(['Files'], [f]), el('xterm-helper-textarea', true)), true, 'the terminal');
  assert.equal(takesPaste(dt(['Files'], [f]), el('x', true)), false, 'the folder field');
  const cells = { name: 'image.png', type: 'image/png' } as File;
  assert.equal(takesPaste(dt(['text/plain', 'image/png'], [], [{ kind: 'file', getAsFile: () => cells }]), null), false, 'spreadsheet cells');
  assert.equal(takesPaste(dt(['text/plain'], []), null), false);
  const pic = { name: 'image.png', type: 'image/png' } as File;
  assert.equal(takesPaste(dt(['text/plain', 'Files'], [pic]), null), false, 'Excel in Chrome: files hold a picture of the cells');
  assert.equal(takesPaste(dt(['Files'], [pic]), null), true, 'a screenshot from the clipboard');
});
