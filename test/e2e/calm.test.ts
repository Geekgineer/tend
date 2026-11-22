import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { killSocket, launchOf, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = tempHome();
let srv: Awaited<ReturnType<typeof startServer>>;

type Res = { status: number; json: () => any; text: string };
function call(method: string, path: string, body?: unknown, raw?: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request(srv.url + path, { method, headers: { 'x-tend-token': srv.token, 'content-type': 'application/json', ...headers } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: () => JSON.parse(b), text: b }));
    });
    r.on('error', reject);
    r.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}
const view = async (id: string): Promise<any> => ((await call('GET', '/api/sessions')).json() as any[]).find((s) => s.id === id);
const type = (id: string, text: string) => call('POST', `/api/sessions/${id}/keys`, undefined, `${text}\r`);
const hook = (id: string, body: unknown) => call('POST', '/hook', body, undefined, { 'x-tend-session': id, 'x-tend-launch': launchOf(home, id) });
const notes = (): any[] => (existsSync(join(home, 'notify.jsonl')) ? readFileSync(join(home, 'notify.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const mk = async (name: string): Promise<string> => (await call('POST', '/api/sessions', { cwd: home, name, isolate: false })).json().id;
const screen = async (id: string) => Buffer.from((await call('GET', `/api/sessions/${id}/snapshot`)).text, 'base64').toString('utf8');

before(async () => {
  srv = await startServer({ TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'stub', TEND_CLAUDE_BIN: FAKE, TEND_FOCUS: '1', TEND_WATCH_MS: '100' });
});
after(async () => {
  await srv?.stop();
  killSocket(socket);
});

test('settings: defaults, a validated update, a 400 on bad input', async () => {
  const s = (await call('GET', '/api/settings')).json();
  assert.deepEqual(s, { focus: { enabled: true, minutes: 25 }, quiet: { enabled: false, start: '22:00', end: '08:00' }, budgetPerHour: 6, wipLimit: 8 });
  const r = await call('PUT', '/api/settings', { wipLimit: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.json().wipLimit, 3);
  assert.equal((await call('PUT', '/api/settings', { focus: { minutes: 1 } })).status, 400);
  assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).wipLimit, 3);
});

test('a low-risk permission is held for the focus window; a high-risk one interrupts; Show now releases', async () => {
  const a = await mk('quiet-one');
  const b = await mk('risky');
  await type(a, 'bash ls');
  await until(async () => (await view(a)).decisions?.length === 1 || undefined, 5000, 'card');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(notes().length, 0, 'held');
  const att = (await call('GET', '/api/attention')).json();
  assert.deepEqual(att.held.map((h: any) => h.sessionId), [a]);
  assert.ok(att.nextRelease > Date.now());
  await type(b, 'bash rm -rf build');
  await until(() => notes().length === 1 || undefined, 3000, 'urgent notification');
  assert.match(notes()[0].title, /^risky/);
  await call('POST', '/api/attention/show');
  await until(() => notes().length === 2 || undefined, 3000, 'released');
  assert.match(notes()[1].title, /^quiet-one/);
  assert.deepEqual((await call('GET', '/api/attention')).json().held, []);
});

test('a high-risk request behind a waiting card still interrupts at once', async () => {
  const s = await mk('two-cards');
  await type(s, 'bash ls -la');
  await until(async () => (await view(s)).decisions?.length === 1 || undefined, 5000, 'first card');
  const before = notes().length;
  await type(s, 'bash rm -rf ~/projects');
  await until(async () => (await view(s)).decisions?.length === 2 || undefined, 5000, 'second card');
  await until(() => notes().slice(before).some((n) => /High-risk request: Recursive delete/.test(n.body)) || undefined, 3000, 'urgent notification');
});

test('a session whose pane dies is crashed (urgent); a normal /exit is not', async () => {
  const c = await mk('crashy');
  const before = notes().length;
  execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-session', '-t', `=tend-${c}`]);
  const v = await until(async () => {
    const x = await view(c);
    return x.state.status === 'ended' ? x : undefined;
  }, 5000, 'ended');
  assert.equal(v.crashed, true);
  await until(() => notes().slice(before).some((n) => n.body === 'Session ended unexpectedly') || undefined, 3000, 'crash notification');
  const d = await mk('clean');
  await type(d, 'exit');
  const w = await until(async () => {
    const x = await view(d);
    return x.state.status === 'ended' ? x : undefined;
  }, 5000, 'ended');
  assert.equal(w.crashed, undefined);
});

test('Claude ending for a reason the user didn\'t ask for is a crash; /exit is not', async () => {
  const a = await mk('killed');
  await hook(a, { hook_event_name: 'SessionEnd', reason: 'other' }); // real 2.1.312 when its terminal is killed
  await until(async () => ((await view(a)).crashed ? true : undefined), 3000, 'crashed');
  const b = await mk('exited');
  await hook(b, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  await until(async () => ((await view(b)).state.status === 'ended' ? true : undefined), 3000, 'ended');
  assert.equal((await view(b)).crashed, undefined);
});

test('three of the same failure flag the session stuck, with the error verbatim; a success clears it', async () => {
  const s = await mk('loop');
  const fail = { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'npm ERR! missing script: "lint" (code 1)', is_interrupt: false };
  for (let i = 0; i < 3; i++) await hook(s, fail);
  const v = await until(async () => (await view(s)).stuck, 3000, 'stuck');
  assert.equal(v.reason, 'repeating');
  assert.equal(v.error, fail.error);
  assert.equal(v.count, 3);
  await hook(s, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  await until(async () => ((await view(s)).stuck ? undefined : true), 3000, 'cleared');
});

test('park everything types one message into working sessions only', async () => {
  const w = await mk('busy');
  const i = await mk('resting');
  await hook(w, { hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  await until(async () => (await view(w)).state.status === 'working' || undefined, 3000, 'working');
  await new Promise((r) => setTimeout(r, 2100)); // sessions that only just changed are skipped (unit-tested)
  const r = (await call('POST', '/api/park')).json();
  assert.ok(r.asked.includes(w));
  assert.ok(!r.asked.includes(i));
  await until(async () => (await screen(w)).includes('park everything') || undefined, 3000, 'message typed');
  assert.ok(!(await screen(i)).includes('park everything'));
});

test('park never types into a session with a card waiting or a dialog on screen', async () => {
  const s = await mk('asking');
  await type(s, 'perm'); // the fake draws a 3-option dialog and holds a PermissionRequest
  await until(async () => (await view(s)).decisions?.length === 1 || undefined, 3000, 'card');
  await hook(s, { hook_event_name: 'PreToolUse', tool_name: 'Write' }); // stale "working"
  await new Promise((r) => setTimeout(r, 2100));
  assert.ok(!(await call('POST', '/api/park')).json().asked.includes(s));
});

test('Esc during a tool leaves the session idle, not working', async () => {
  const s = await mk('esc');
  await hook(s, { hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  await hook(s, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'Interrupted', is_interrupt: true });
  await until(async () => (await view(s)).state.status === 'idle' || undefined, 3000, 'idle');
});

test('the wrap-up counts decisions, interruptions sent and held, and time waiting', async () => {
  const w = (await call('GET', `/api/wrapup?since=${Date.now() - 3600_000}`)).json();
  assert.ok(w.decisions >= 2, JSON.stringify(w));
  assert.ok(w.interruptions.sent >= 2);
  assert.ok(w.interruptions.held >= 1);
  assert.ok(w.started >= 6);
  assert.ok(w.waiting > 0);
  assert.equal((await call('GET', '/api/wrapup')).status, 200);
});
