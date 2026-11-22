import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'phase0');
const ZERO = '00000000-0000-0000-0000-000000000000';
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const bodies = files.map((f) => ({ f, text: readFileSync(join(DIR, f), 'utf8') }));

test('fixtures contain no personal paths, names or real UUIDs', () => {
  assert.ok(files.length > 0);
  for (const { f, text } of bodies) {
    for (const bad of ['/Users/', userInfo().username, `claude-${userInfo().uid}`]) {
      assert.ok(!text.includes(bad), `${f} contains ${bad}`);
    }
    const uuids = text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g) ?? [];
    for (const u of uuids) assert.equal(u, ZERO, `${f} contains uuid ${u}`);
  }
});

test('fixture corpus covers the needed events and tools', () => {
  const parsed = bodies.map(({ text }) => JSON.parse(text) as { hook_event_name: string; tool_name?: string });
  const count = (e: string) => parsed.filter((p) => p.hook_event_name === e).length;
  assert.ok(count('PermissionRequest') >= 6);
  assert.ok(count('Stop') >= 6);
  assert.ok(count('PostToolUseFailure') >= 1);
  const perms = parsed.filter((p) => p.hook_event_name === 'PermissionRequest');
  assert.ok(perms.some((p) => p.tool_name === 'AskUserQuestion'));
  assert.ok(perms.some((p) => p.tool_name === 'ExitPlanMode'));
});
