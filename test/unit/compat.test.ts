import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCompat, parseVersion, selfTest, SHIPPED_VERSIONS } from '../../src/compat.ts';
import { tempHome } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');

test('version parsing and the verified list', async () => {
  assert.equal(parseVersion('2.1.312 (Claude Code)'), '2.1.312');
  assert.equal(parseVersion('nope'), null);
  assert.ok(SHIPPED_VERSIONS.includes('2.1.312'));
  const home = tempHome();
  process.env.FAKE_CLAUDE_VERSION = '2.1.400';
  try {
    const c = createCompat({ home, bin: () => FAKE });
    await c.refresh();
    assert.deepEqual(c.view(), { version: '2.1.400', verified: false, last: null, running: false });
    const r = await c.selfTest();
    assert.equal(r.ok, true, JSON.stringify(r.missing));
    assert.equal(c.view().verified, true);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'compat.json'), 'utf8')).verified, ['2.1.400']);
    // a new Tend reads it back
    const again = createCompat({ home, bin: () => FAKE });
    await again.refresh();
    assert.equal(again.view().verified, true);
  } finally {
    delete process.env.FAKE_CLAUDE_VERSION;
  }
});

test('a self-test names what is missing', async () => {
  process.env.FAKE_SKIP_PERMISSION = '1';
  try {
    const missing = await selfTest(FAKE);
    assert.ok(missing.includes('PermissionRequest hook'), JSON.stringify(missing));
    assert.ok(missing.includes('a permission answered by the hook did not run the tool'));
  } finally {
    delete process.env.FAKE_SKIP_PERMISSION;
  }
});

test('the banner says nothing for a checked version, offers a self-test otherwise, and names failures', async () => {
  const { bannerText } = await import('../../ui/compat.js');
  assert.equal(bannerText({ version: '2.1.312', verified: true, last: null, running: false }), null);
  assert.equal(bannerText({ version: null, verified: false, last: null, running: false }), null);
  assert.match(bannerText({ version: '2.1.400', verified: false, last: null, running: false })!, /hasn't been checked/);
  assert.match(bannerText({ version: '2.1.400', verified: false, last: { version: '2.1.400', ok: false, missing: ['PermissionRequest hook'], at: 1 }, running: false })!, /PermissionRequest hook/);
});
