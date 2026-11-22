import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duration, sinceYouLeft, wipNote, wrapupRows } from '../../ui/calm.js';
import { problemText } from '../../ui/list.js';

const w = { since: 0, decisions: 3, finished: 2, started: 1, interruptions: { sent: 4, held: 6 }, waiting: 80 * 60_000, commits: 1 };

test('"Since you left" says what happened, or nothing', () => {
  assert.equal(sinceYouLeft(w, 2), 'Since you left: 2 turns finished, 3 requests for you, 1 commit, 2 waiting on you now.');
  assert.equal(sinceYouLeft({ ...w, decisions: 0, finished: 0, commits: 0 }, 0), null);
});

test('soft limit note only at or over the limit, never a block', () => {
  assert.equal(wipNote(7, 8), null);
  assert.match(wipNote(9, 8)!, /^You have 9 sessions going; your limit is 8\./);
});

test('wrap-up rows and durations', () => {
  assert.deepEqual(wrapupRows(w).map((r) => r.join(': ')), [
    'Decisions: 3', 'Turns finished: 2', 'Sessions started: 1', 'Commits: 1', 'Interruptions: 4 sent · 6 held', 'Time waiting on you: 1 h 20 min',
  ]);
  assert.equal(duration(20_000), 'under a minute');
  assert.equal(duration(60 * 60_000), '1 h');
});

test('problem rows: crashed and stuck', () => {
  const v = { crashed: true } as any;
  assert.equal(problemText(v), 'Ended unexpectedly');
  assert.equal(problemText({ stuck: { reason: 'repeating', tool: 'Bash', count: 3, since: 0 } } as any), 'Stuck · same Bash error 3×');
  assert.equal(problemText({ stuck: { reason: 'silent', since: 0 } } as any), 'Stuck · no progress for 10 min');
  assert.equal(problemText({} as any), null);
});
