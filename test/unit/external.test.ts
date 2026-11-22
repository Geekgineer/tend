import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptBlocker, createExternal, parseEntry } from '../../src/external.ts';
import type { ExternalRow } from '../../src/external.ts';
import { externalDetail } from '../../ui/external.js';

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const entry = (sessionId: string, o: Record<string, unknown> = {}) => ({ pid: 4242, cwd: '/tmp/x', kind: 'interactive', startedAt: 1, sessionId, name: 'x', status: 'idle', ...o });

function harness(lists: Record<string, unknown[] | 'fail'>, alive = new Set<number>(), gone = new Set<string>()) {
  let t = 1000;
  const calls: { argv: string[]; dir: string | undefined }[] = [];
  const own = new Set<string>();
  const ext = createExternal({
    bin: () => 'claude',
    accounts: () => Object.keys(lists).map((dir) => ({ dir, name: dir })),
    homeClaude: '/home/.claude',
    own: () => own,
    alive: (pid) => alive.has(pid),
    exists: (d) => !gone.has(d),
    now: () => t,
    run: async (argv, env) => {
      calls.push({ argv, dir: env.CLAUDE_CONFIG_DIR });
      const l = lists[env.CLAUDE_CONFIG_DIR ?? '/home/.claude'];
      if (l === 'fail' || l === undefined) throw new Error('boom');
      return JSON.stringify(l);
    },
  });
  return { ext, calls, own, lists, tick: (ms: number) => (t += ms) };
}

test('entries are validated: a bad id, a relative folder or an unknown kind is dropped', () => {
  assert.equal(parseEntry(entry('nope')), null);
  assert.equal(parseEntry(entry(A, { cwd: 'rel' })), null);
  assert.equal(parseEntry(entry(A, { kind: 'daemon' })), null);
  assert.equal(parseEntry(null), null);
  const r = parseEntry(entry(A, { id: '7782a315', name: '  ', cwd: '/a/b' }))!;
  assert.equal(r.name, 'b');
  assert.equal(r.attachId, '7782a315');
});

test('each account is asked with its own config folder; the home one runs without CLAUDE_CONFIG_DIR', async () => {
  const h = harness({ '/home/.claude': [entry(A)], '/acct2': [entry(B)] });
  const rows = await h.ext.list();
  assert.deepEqual(rows.map((r) => [r.sessionId, r.account, r.live]).sort(), [[A, '/home/.claude', true], [B, '/acct2', true]].sort());
  assert.deepEqual(h.calls.map((c) => c.dir).sort(), [undefined, '/acct2'].sort());
  assert.deepEqual(h.calls[0]!.argv, ['claude', 'agents', '--json']);
});

test("tend's own sessions are never listed as elsewhere", async () => {
  const h = harness({ '/home/.claude': [entry(A), entry(B)] });
  h.own.add(B);
  assert.deepEqual((await h.ext.list()).map((r) => r.sessionId), [A]);
});

test('a session that leaves the listing becomes closed (adoptable), but not while its process is still there', async () => {
  const alive = new Set([4242]);
  const h = harness({ '/home/.claude': [entry(A)] }, alive);
  await h.ext.list();
  h.lists['/home/.claude'] = [];
  h.tick(5000);
  assert.equal((await h.ext.list())[0]!.live, true, 'pid still alive: keep it open');
  alive.clear();
  h.tick(5000);
  const r = (await h.ext.list())[0]!;
  assert.equal(r.live, false);
  assert.equal(r.closedAt, h.tick(0));
});

test('a failed listing never marks that account\'s sessions closed', async () => {
  const h = harness({ '/home/.claude': [entry(A)] });
  await h.ext.list();
  h.lists['/home/.claude'] = 'fail';
  h.tick(5000);
  assert.equal((await h.ext.list())[0]!.live, true);
});

test('listing is cached for a few seconds and shared by concurrent callers; force looks again', async () => {
  const h = harness({ '/home/.claude': [entry(A)] });
  await Promise.all([h.ext.list(), h.ext.list(), h.ext.list()]);
  assert.equal(h.calls.length, 1);
  await h.ext.list();
  assert.equal(h.calls.length, 1);
  await h.ext.list(true);
  assert.equal(h.calls.length, 2);
});

test('closed sessions are forgotten after 12 hours', async () => {
  const h = harness({ '/home/.claude': [entry(A, { pid: 0 })] });
  await h.ext.list();
  h.lists['/home/.claude'] = [];
  h.tick(5000);
  assert.equal((await h.ext.list()).length, 1);
  h.tick(13 * 3600_000);
  assert.equal((await h.ext.list()).length, 0);
});

test('adopt is blocked while open, for a missing folder, or with no saved conversation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tend-ext-'));
  const row: ExternalRow = { sessionId: A, name: 'x', cwd: dir, kind: 'interactive', status: '', startedAt: 1, account: '/a', live: false, closedAt: 2 };
  assert.match(adoptBlocker(undefined, () => true)!, /no longer listed/);
  assert.match(adoptBlocker({ ...row, live: true }, () => true)!, /still open/);
  assert.match(adoptBlocker({ ...row, cwd: join(dir, 'gone') }, () => true)!, /folder is gone/);
  assert.match(adoptBlocker(row, () => false)!, /no conversation/);
  assert.equal(adoptBlocker(row, () => true), null);
});

test('row text says where it runs and how to adopt it', () => {
  const r = { sessionId: A, name: 'x', cwd: '/x', kind: 'interactive' as const, status: 'busy', startedAt: 1, account: '/a', live: true };
  assert.equal(externalDetail(r), 'Working · in its own terminal');
  assert.equal(externalDetail({ ...r, kind: 'background', status: 'idle', attachId: '7782a315' }), 'Idle · background · claude attach 7782a315');
  assert.equal(externalDetail({ ...r, live: false, closedAt: 0 }, 5 * 60_000), 'Closed 5m ago · adopt to continue it here');
  assert.equal(externalDetail({ ...r, live: false, closedAt: 0 }, 1000), 'Closed just now · adopt to continue it here');
});

test('a row that leaves the listing while its pid lingers is forgotten after a minute, never offered for adopt', async () => {
  const h = harness({ '/home/.claude': [entry(A)] }, new Set([4242]));
  await h.ext.list();
  h.lists['/home/.claude'] = [];
  h.tick(5000);
  assert.equal((await h.ext.list())[0]!.live, true);
  h.tick(30_000);
  assert.equal((await h.ext.list()).length, 1);
  h.tick(40_000);
  assert.equal((await h.ext.list()).length, 0);
});

test('closed rows whose folder is gone (e.g. finished test runs) are not listed', async () => {
  const gone = new Set<string>();
  const h = harness({ '/home/.claude': [entry(A, { pid: 0, cwd: '/tmp/run1' }), entry(B, { pid: 0, cwd: '/tmp/keep' })] }, new Set(), gone);
  await h.ext.list();
  gone.add('/tmp/run1');
  assert.equal((await h.ext.list()).length, 2, 'live rows stay even if the folder looks gone');
  h.lists['/home/.claude'] = [];
  h.tick(5000);
  assert.deepEqual((await h.ext.list()).map((r) => r.cwd), ['/tmp/keep']);
});
