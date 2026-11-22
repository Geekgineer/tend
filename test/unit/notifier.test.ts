import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNotifier, notifyModeFromEnv } from '../../src/notifier.ts';

const intent = { sessionId: 's1', title: 'a "quoted" \\ title', body: 'say "hi" \\ there' };

test('osascript mode escapes quotes and backslashes in argv', () => {
  const calls: Array<[string, string[]]> = [];
  createNotifier({ mode: 'osascript', run: (c, a) => calls.push([c, a]) })(intent);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript');
  assert.deepEqual(calls[0][1], [
    '-e',
    'display notification "say \\"hi\\" \\\\ there" with title "a \\"quoted\\" \\\\ title" subtitle "tend."',
  ]);
});

test('stub mode appends one JSON line per call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tend-notif-'));
  const stubFile = path.join(dir, 'n.jsonl');
  try {
    const n = createNotifier({ mode: 'stub', stubFile });
    n(intent);
    n({ ...intent, sessionId: 's2' });
    const lines = fs.readFileSync(stubFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), intent);
    assert.equal(JSON.parse(lines[1]).sessionId, 's2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('off mode does nothing', () => {
  let ran = false;
  createNotifier({ mode: 'off', run: () => { ran = true; } })(intent);
  assert.equal(ran, false);
});

test('notifyModeFromEnv honours TEND_NOTIFY', () => {
  assert.equal(notifyModeFromEnv({ TEND_NOTIFY: 'stub' }), 'stub');
  assert.equal(notifyModeFromEnv({ TEND_NOTIFY: 'off' }), 'off');
  assert.equal(notifyModeFromEnv({ TEND_NOTIFY: 'osascript' }), 'osascript');
  assert.equal(notifyModeFromEnv({}, 'darwin'), 'osascript');
  assert.equal(notifyModeFromEnv({}, 'linux'), 'off');
  assert.equal(notifyModeFromEnv({ TEND_NOTIFY: 'bogus' }, 'linux'), 'off');
});
