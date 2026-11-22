import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { tempHome } from '../helpers.ts';
import { buildSettings, writeSettings } from '../../src/claude-launch.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');

type Hit = { event: string; token: unknown; session: unknown; sid: unknown };

async function run(inputs: string[], want: number): Promise<{ hits: Hit[]; out: string; code: number | null }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = JSON.parse(b);
      hits.push({ event: j.hook_event_name, token: req.headers['x-tend-token'], session: req.headers['x-tend-session'], sid: j.session_id });
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const path = writeSettings(tempHome(), 'abcd1234', buildSettings({ port, token: 'tok', sessionId: 'abcd1234', launch: 'l0' }));
  const child = spawn(FAKE, ['--settings', path, '--name', 'x'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit') as Promise<[number | null]>;
  child.stdin.on('error', () => {});
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  for (const i of inputs) child.stdin.write(i + '\n');
  const deadline = Date.now() + 8000;
  while (hits.length < want && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  child.stdin.end();
  const [code] = await exited;
  server.closeAllConnections();
  server.close();
  return { hits, out, code };
}

test('perm replays PermissionRequest then Notification with both headers, then prints a 3-option dialog', async () => {
  const { hits, out } = await run(['perm'], 2);
  assert.deepEqual(hits.map((h) => h.event), ['PermissionRequest', 'Notification']);
  for (const h of hits) {
    assert.equal(h.token, 'tok');
    assert.equal(h.session, 'abcd1234');
    assert.notEqual(h.sid, '00000000-0000-0000-0000-000000000000');
  }
  assert.ok(out.includes('fake claude'));
  assert.ok(out.includes('\r\n'));
  assert.match(out, /1\..*\r\n.*2\..*\r\n.*3\./s);
});

test('ok, ask, other and exit replay the right sequences; exit ends with code 0', async () => {
  const { hits, code } = await run(['ok', 'ask', 'hello', 'exit'], 3 + 1 + 4 + 1);
  // `ask` is held like a real PermissionRequest, so it runs alongside the rest
  const events = hits.map((h) => h.event);
  assert.equal(events.filter((e) => e === 'PermissionRequest').length, 1);
  assert.deepEqual(events.filter((e) => e !== 'PermissionRequest'), [
    'PostToolUse', 'Stop', 'SubagentStop',
    'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd',
  ]);
  assert.equal(code, 0);
});
