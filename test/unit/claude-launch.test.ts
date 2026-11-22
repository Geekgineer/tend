import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from '../helpers.ts';
import { buildSettings, writeSettings, launchArgv, claudeBin, writeCurlConfig, sessionStartCommand } from '../../src/claude-launch.ts';

const U = '11111111-2222-4333-8444-555555555555';
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];

test('buildSettings has exactly the 9 http events; PermissionRequest waits 3600 s, the rest 10 s', () => {
  const s = buildSettings({ port: 4977, token: 'tok', sessionId: 'abcd1234', launch: 'l0' }) as { hooks: Record<string, unknown[]> };
  assert.deepEqual(Object.keys(s.hooks).sort(), [...EVENTS].sort());
  for (const ev of EVENTS) {
    assert.deepEqual(s.hooks[ev], [
      { matcher: '', hooks: [{ type: 'http', url: 'http://127.0.0.1:4977/hook', timeout: ev === 'PermissionRequest' ? 3600 : 10, headers: { 'x-tend-token': 'tok', 'x-tend-session': 'abcd1234', 'x-tend-launch': 'l0' } }] },
    ]);
  }
  assert.ok(!JSON.stringify(s).includes('dangerously'));
});

test('SessionStart is a curl command hook; the token lives only in a 0600 curl config', () => {
  const home = tempHome();
  const target = { port: 4977, token: 'tok', sessionId: 'abcd1234', launch: 'l0' };
  const conf = writeCurlConfig(home, 'abcd1234', target);
  assert.equal(conf, join(home, 'sessions', 'abcd1234', 'curl.conf'));
  assert.equal(statSync(conf).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(conf, 'utf8'),
    'url = "http://127.0.0.1:4977/hook"\nheader = "content-type: application/json"\nheader = "x-tend-token: tok"\nheader = "x-tend-session: abcd1234"\nheader = "x-tend-launch: l0"\n',
  );
  const s = buildSettings({ ...target, curlConfig: conf }) as { hooks: Record<string, any[]> };
  const cmd = s.hooks.SessionStart[0].hooks[0];
  assert.equal(cmd.type, 'command');
  assert.ok(!cmd.command.includes('tok'), 'no token in argv');
  assert.equal(sessionStartCommand("/a b/it's/curl.conf"), `curl -s -m 5 -K '/a b/it'\\''s/curl.conf' --data-binary @- >/dev/null 2>&1 || true`);
});

test('writeSettings writes sessions/<id>/settings.json with mode 0600', () => {
  const home = tempHome();
  const s = buildSettings({ port: 1, token: 't', sessionId: 'abcd1234', launch: 'l0' });
  const p = writeSettings(home, 'abcd1234', s);
  assert.equal(p, join(home, 'sessions', 'abcd1234', 'settings.json'));
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), s);
});

test('launchArgv order is exact; the claude id rides in one --x=<id> argument', () => {
  assert.deepEqual(launchArgv('claude', '/x/settings.json', 'n', { id: U, resume: false }), ['claude', '--settings', '/x/settings.json', '--name=n', `--session-id=${U}`]);
  assert.deepEqual(launchArgv('claude', '/x/settings.json', 'n', { id: U, resume: true }), ['claude', '--settings', '/x/settings.json', '--name=n', `--resume=${U}`]);
  assert.equal(launchArgv('claude', '/x/s.json', '--dangerously-skip-permissions', { id: U, resume: true })[3], '--name=--dangerously-skip-permissions', 'a dash name stays the value of --name');
});

test('claudeBin honours TEND_CLAUDE_BIN', () => {
  const old = process.env.TEND_CLAUDE_BIN;
  try {
    delete process.env.TEND_CLAUDE_BIN;
    assert.equal(claudeBin(), 'claude');
    process.env.TEND_CLAUDE_BIN = '/fake';
    assert.equal(claudeBin(), '/fake');
  } finally {
    if (old === undefined) delete process.env.TEND_CLAUDE_BIN; else process.env.TEND_CLAUDE_BIN = old;
  }
});

test('launchArgv appends whitespace-split TEND_CLAUDE_ARGS; empty or unset adds nothing', () => {
  const old = process.env.TEND_CLAUDE_ARGS;
  try {
    process.env.TEND_CLAUDE_ARGS = '--model  haiku ';
    assert.deepEqual(launchArgv('claude', '/s.json', 'n', { id: U, resume: false }), ['claude', '--settings', '/s.json', '--name=n', `--session-id=${U}`, '--model', 'haiku']);
    process.env.TEND_CLAUDE_ARGS = '';
    assert.equal(launchArgv('claude', '/s.json', 'n', { id: U, resume: false }).length, 5);
    delete process.env.TEND_CLAUDE_ARGS;
    assert.equal(launchArgv('claude', '/s.json', 'n', { id: U, resume: false }).length, 5);
  } finally {
    if (old === undefined) delete process.env.TEND_CLAUDE_ARGS; else process.env.TEND_CLAUDE_ARGS = old;
  }
});
