import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapup } from '../../src/wrapup.ts';

const ev = (sessionId: string, kind: string, ts: number) => ({ sessionId, kind, ts, data: {} }) as any;

test('wrap-up counts decisions, finished turns and time waiting on you since a moment', () => {
  const w = wrapup({
    since: 1000,
    now: 10_000,
    before: new Map([['a', { status: 'needs_you', need: 'permission', since: 500 }]]),
    events: [
      ev('a', 'decided', 3000), // a waited 1000 → 3000 (2 s counted from `since`)
      ev('a', 'Stop', 4000),
      ev('b', 'UserPromptSubmit', 2000),
      ev('b', 'PermissionRequest', 5000), // b waits 5000 → 6000
      ev('b', 'PostToolUse', 6000),
      ev('b', 'Stop', 7000),
      ev('c', 'PermissionRequest', 9000), // c still waiting at now: 1 s
    ],
    startedSince: 2,
    notices: [{ kind: 'sent' }, { kind: 'held' }, { kind: 'held' }],
    commits: 4,
  });
  assert.deepEqual(w, { since: 1000, decisions: 2, finished: 2, started: 2, interruptions: { sent: 1, held: 2 }, waiting: 2000 + 1000 + 1000, commits: 4 });
});
