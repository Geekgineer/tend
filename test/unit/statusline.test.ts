import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userStatusLine } from '../../src/statusline.ts';
import { listAccounts } from '../../src/accounts.ts';
import { tempHome } from '../helpers.ts';

const settings = (dir: string, file: string, statusLine: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify({ statusLine }));
};

test('the user\'s effective statusLine: project local > project shared > account settings', () => {
  const project = tempHome();
  const config = tempHome();
  assert.equal(userStatusLine(project, config), null);
  settings(config, 'settings.json', { type: 'command', command: 'echo user' });
  assert.equal(userStatusLine(project, config), 'echo user');
  assert.equal(userStatusLine(null, config), 'echo user');
  settings(join(project, '.claude'), 'settings.json', { type: 'command', command: 'echo shared' });
  assert.equal(userStatusLine(project, config), 'echo shared');
  settings(join(project, '.claude'), 'settings.local.json', { type: 'command', command: 'echo local' });
  assert.equal(userStatusLine(project, config), 'echo local');
  // never Tend's own wrapper (no loop), and a non-command statusLine decides "none"
  settings(join(project, '.claude'), 'settings.local.json', { type: 'command', command: '/x/node /tend/bin/tend-statusline.mjs /c' });
  assert.equal(userStatusLine(project, config), null);
  settings(join(project, '.claude'), 'settings.local.json', { type: 'static', text: 'x' });
  assert.equal(userStatusLine(project, config), null);
  writeFileSync(join(project, '.claude', 'settings.local.json'), '{broken');
  assert.equal(userStatusLine(project, config), 'echo shared');
  // disableAllHooks anywhere: run none of the user's commands
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ disableAllHooks: true, statusLine: { type: 'command', command: 'echo user' } }));
  assert.equal(userStatusLine(project, config), null);
});

test('accounts: the default folder first, then TEND_ACCOUNTS folders that exist, without duplicates', () => {
  const a = join(tempHome(), '.claude-work');
  mkdirSync(a);
  const old = { dir: process.env.CLAUDE_CONFIG_DIR, acc: process.env.TEND_ACCOUNTS };
  try {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/default-claude';
    process.env.TEND_ACCOUNTS = `${a}:/does/not/exist:${a}:/tmp/default-claude`;
    assert.deepEqual(listAccounts(), [{ dir: '/tmp/default-claude', name: 'Default' }, { dir: a, name: 'work' }]);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = old.dir;
    process.env.TEND_ACCOUNTS = old.acc;
  }
});
