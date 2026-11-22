import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalize } from '../../src/events.ts';

const load = (n: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'phase0', n), 'utf8')) as unknown;

test('PermissionRequest normalises with tool and claudeSessionId', () => {
  const body = load('005-PermissionRequest.json') as { session_id: string };
  const ev = normalize(body, 'abcd1234', 42);
  assert.ok(ev);
  assert.equal(ev.kind, 'PermissionRequest');
  assert.equal(ev.tool, 'Write');
  assert.equal(ev.sessionId, 'abcd1234');
  assert.equal(ev.ts, 42);
  assert.equal(ev.claudeSessionId, body.session_id);
  assert.equal(ev.data, body);
});

test('session_id is kept only when it is a UUID (any case)', () => {
  const sid = (session_id: unknown) => normalize({ hook_event_name: 'Stop', session_id }, 'abcd1234', 1)?.claudeSessionId;
  assert.equal(sid('11111111-2222-4333-8444-555555555555'), '11111111-2222-4333-8444-555555555555');
  assert.equal(sid('ABCDEF01-2222-4333-8444-555555555555'), 'ABCDEF01-2222-4333-8444-555555555555');
  for (const bad of ['../../etc/passwd', '--settings=/x', 'x', '', '11111111-2222-4333-8444-5555555555551', 7]) {
    assert.equal(sid(bad), undefined, String(bad));
  }
});

test('AskUserQuestion keeps its tool name', () => {
  const ev = normalize(load('023-PermissionRequest.json'), 'abcd1234', 1);
  assert.equal(ev?.tool, 'AskUserQuestion');
});

test('unknown or malformed bodies return null', () => {
  assert.equal(normalize({ hook_event_name: 'Bogus' }, 'abcd1234', 1), null);
  assert.equal(normalize(null, 'abcd1234', 1), null);
  assert.equal(normalize('x', 'abcd1234', 1), null);
});

test('Stop has no tool', () => {
  const ev = normalize(load('009-Stop.json'), 'abcd1234', 1);
  assert.equal(ev?.kind, 'Stop');
  assert.equal(ev?.tool, undefined);
});
