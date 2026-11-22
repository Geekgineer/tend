import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store.ts';
import type { SessionRow } from '../../src/store.ts';
import type { TendEvent } from '../../src/events.ts';

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tend-store-'));
  return { file: path.join(dir, 'tend.db'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const sess = (id: string, createdAt: number): SessionRow => ({
  id, name: `s-${id}`, cwd: '/tmp', createdAt, endedAt: null,
  claudeId: '', launch: '', workspace: { mode: 'inplace' }, paused: false, archived: false, account: '', context: '',
});

test('round-trips a session and 3 events', () => {
  const t = tmpDb();
  const s = openStore(t.file);
  try {
    s.addSession(sess('aaaaaaaa', 1));
    const evs: TendEvent[] = [
      { ts: 1, sessionId: 'aaaaaaaa', kind: 'UserPromptSubmit', data: { prompt: 'hi' } },
      { ts: 2, sessionId: 'aaaaaaaa', kind: 'PreToolUse', tool: 'Bash', claudeSessionId: 'c1', data: { a: 1 } },
      { ts: 3, sessionId: 'aaaaaaaa', kind: 'pane_exit', data: null },
    ];
    for (const e of evs) s.appendEvent(e);
    assert.deepEqual(s.getSession('aaaaaaaa'), sess('aaaaaaaa', 1));
    assert.equal(s.getSession('bbbbbbbb'), undefined);
    assert.deepEqual(s.eventsFor('aaaaaaaa'), evs);
    assert.deepEqual(s.eventsFor('bbbbbbbb'), []);
  } finally { s.close(); t.cleanup(); }
});

test('persists across close and reopen', () => {
  const t = tmpDb();
  try {
    const a = openStore(t.file);
    a.addSession(sess('aaaaaaaa', 1));
    a.appendEvent({ ts: 5, sessionId: 'aaaaaaaa', kind: 'Stop', data: {} });
    a.close();
    const b = openStore(t.file);
    assert.equal(b.listSessions().length, 1);
    assert.equal(b.eventsFor('aaaaaaaa').length, 1);
    b.close();
  } finally { t.cleanup(); }
});

test('listSessions is newest first', () => {
  const t = tmpDb();
  const s = openStore(t.file);
  try {
    s.addSession(sess('aaaaaaaa', 1));
    s.addSession(sess('cccccccc', 3));
    s.addSession(sess('bbbbbbbb', 2));
    assert.deepEqual(s.listSessions().map((r) => r.id), ['cccccccc', 'bbbbbbbb', 'aaaaaaaa']);
  } finally { s.close(); t.cleanup(); }
});

test('markEnded sets endedAt', () => {
  const t = tmpDb();
  const s = openStore(t.file);
  try {
    s.addSession(sess('aaaaaaaa', 1));
    s.markEnded('aaaaaaaa', 99);
    assert.equal(s.getSession('aaaaaaaa')?.endedAt, 99);
  } finally { s.close(); t.cleanup(); }
});

test('addSession round-trips every SessionRow field', () => {
  const t = tmpDb();
  const s = openStore(t.file);
  try {
    const row: SessionRow = {
      id: 'aaaaaaaa', name: 'n', cwd: '/r/sub', createdAt: 1, endedAt: 7,
      claudeId: 'c-uuid', launch: 'deadbeefdeadbeef',
      workspace: { mode: 'worktree', repo: '/r', commonDir: '/r/.git', worktree: '/h/worktrees/aaaaaaaa', branch: 'tend/n-aaaaaaaa', base: 'abc123', subdir: 'sub', wip: null },
      paused: true, archived: true, account: '/h/.claude-work', context: '{"pct":5}',
    };
    s.addSession(row);
    assert.deepEqual(s.getSession('aaaaaaaa'), row);
  } finally { s.close(); t.cleanup(); }
});

test('updateSession patches only the given fields', () => {
  const t = tmpDb();
  const s = openStore(t.file);
  try {
    s.addSession(sess('aaaaaaaa', 1));
    s.updateSession('aaaaaaaa', { claudeId: 'new', paused: true });
    assert.deepEqual(s.getSession('aaaaaaaa'), { ...sess('aaaaaaaa', 1), claudeId: 'new', paused: true });
    s.updateSession('aaaaaaaa', {});
    s.updateSession('aaaaaaaa', { workspace: { mode: 'inplace' }, endedAt: 5 });
    assert.equal(s.getSession('aaaaaaaa')?.endedAt, 5);
    assert.equal(s.getSession('aaaaaaaa')?.claudeId, 'new');
  } finally { s.close(); t.cleanup(); }
});

test('a v0.1 database is migrated in place', () => {
  const t = tmpDb();
  try {
    const db = new DatabaseSync(t.file);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER)');
    db.exec("INSERT INTO sessions (id, name, cwd, created_at, ended_at) VALUES ('aaaaaaaa', 'old', '/x', 3, NULL)");
    db.close();
    for (let i = 0; i < 2; i++) { // reopening an already migrated db is a no-op
      const s = openStore(t.file);
      assert.deepEqual(s.getSession('aaaaaaaa'), {
        id: 'aaaaaaaa', name: 'old', cwd: '/x', createdAt: 3, endedAt: null,
        claudeId: '', launch: '', workspace: { mode: 'inplace' }, paused: false, archived: false, account: '', context: '',
      });
      s.close();
    }
  } finally { t.cleanup(); }
});

test('a corrupt workspace column reads back as in place', () => {
  const t = tmpDb();
  try {
    const s = openStore(t.file);
    s.addSession(sess('aaaaaaaa', 1));
    s.close();
    const db = new DatabaseSync(t.file);
    db.exec(`UPDATE sessions SET workspace = '{not json' WHERE id = 'aaaaaaaa'`);
    db.close();
    const s2 = openStore(t.file);
    assert.deepEqual(s2.getSession('aaaaaaaa')!.workspace, { mode: 'inplace' });
    s2.close();
  } finally { t.cleanup(); }
});

test('usage rows upsert per account folder', () => {
  const t = tmpDb();
  const s = openStore(t.file);
  try {
    s.putUsage('/a', '{"x":1}');
    s.putUsage('/a', '{"x":2}');
    s.putUsage('/b', '{"y":1}');
    assert.deepEqual(s.listUsage().sort((a, b) => a.dir.localeCompare(b.dir)), [{ dir: '/a', json: '{"x":2}' }, { dir: '/b', json: '{"y":1}' }]);
  } finally {
    s.close();
  }
});
