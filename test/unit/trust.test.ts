import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrustCheck } from '../../src/trust.ts';
import type { TendEvent } from '../../src/events.ts';
import type { SessionView } from '../../src/sessions.ts';

const DIALOG = [
  '\x1b[1mDo you trust the files in this folder?\x1b[0m',
  '',
  '/Users/me/project',
  '',
  'Claude Code may read files in this folder. Only continue if you trust this folder.',
  '',
  '\x1b[36m❯ 1. Yes, I trust this folder\x1b[0m',
  '  2. No, exit',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

function check(pane: string): TendEvent['kind'][] {
  const view = { id: 'abcd1234', name: 'n', state: { status: 'starting', since: 0 } } as unknown as SessionView;
  const kinds: TendEvent['kind'][] = [];
  createTrustCheck({
    views: () => [view],
    snapshot: () => Buffer.from(pane),
    apply: (_v, ev) => kinds.push(ev.kind),
    now: () => 1,
  })();
  return kinds;
}

test('the real trust dialog (phrase plus a numbered option list) is spotted', () => {
  assert.deepEqual(check(DIALOG), ['trust_prompt']);
});

// captured from real Claude Code 2.1.312 on 2026-10-28 (unnumbered options)
const REAL_2_1_312 = [
  '─'.repeat(80),
  ' Accessing workspace:',
  ' /private/tmp/x/trust.JYQX',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not,",
  " take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' \x1b[36m❯ No, exit\x1b[0m',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

test('the real Claude Code 2.1.312 trust dialog (unnumbered options) is spotted', () => {
  assert.deepEqual(check(REAL_2_1_312), ['trust_prompt']);
});

test('the phrase in plain text, with no option list, leaves the session starting', () => {
  assert.deepEqual(check('Claude wrote: you should trust this folder before you run it.\n❯ \n'), []);
  assert.deepEqual(check('$ cat notes.md\ntrust this folder\n1) not an option list\n'), []);
});

test('a dialog scrolled more than 15 non-empty lines up no longer counts', () => {
  const later = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n\n');
  assert.deepEqual(check(`${DIALOG}\n${later}\n`), []);
});
