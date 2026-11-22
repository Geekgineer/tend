import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killSocket, launchOf, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = tempHome();
let srv: Awaited<ReturnType<typeof startServer>>;

type Res = { status: number; headers: IncomingMessage['headers']; body: string; json: () => any };

function call(method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request(srv.url + path, { method, headers: o.headers }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b, json: () => JSON.parse(b) }));
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

const auth = (extra: Record<string, string> = {}): Record<string, string> => ({ 'x-tend-token': srv.token, ...extra });
const json = (v: unknown): { headers: Record<string, string>; body: string } => ({
  headers: auth({ 'content-type': 'application/json' }),
  body: JSON.stringify(v),
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  assert.fail(`timed out after ${ms} ms`);
}

before(async () => {
  srv = await startServer({ TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'stub', TEND_CLAUDE_BIN: FAKE });
});

after(async () => {
  await srv?.stop();
  killSocket(socket);
});

test('GET /health is open and answers ok', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json().ok, true);
  assert.equal(typeof r.json().instance, 'string'); // identity for the single-instance lock, not a secret
});

test('API routes need the token', async () => {
  assert.equal((await call('GET', '/api/sessions')).status, 401);
  assert.equal((await call('GET', '/api/events')).status, 401);
});

test('POST /api/sessions starts a session in a folder with shell metacharacters', async () => {
  const dir = join(tempHome(), 'my proj;x');
  mkdirSync(dir);
  const r = await call('POST', '/api/sessions', json({ cwd: dir }));
  assert.equal(r.status, 201);
  const view = r.json();
  assert.match(view.id, /^[0-9a-f]{8}$/);
  assert.equal(view.name, 'my proj;x');
  assert.equal(view.cwd, dir);
  assert.equal(view.state.status, 'starting');
  assert.equal(typeof view.createdAt, 'number');
  await until(async () => {
    const list = (await call('GET', '/api/sessions', { headers: auth() })).json();
    return list.some((s: { id: string }) => s.id === view.id);
  }, 2000);
  const sessions = execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
  assert.ok(sessions.split('\n').includes(`tend-${view.id}`));
  assert.ok(existsSync(join(home, 'sessions', view.id, 'settings.json')));
  // Claude's SessionStart command hook (curl) reaches tend: the session is ready, not "starting"
  await until(async () => {
    const list = (await call('GET', '/api/sessions', { headers: auth() })).json();
    return list.find((s: { id: string }) => s.id === view.id)?.state.status === 'idle';
  }, 5000);
});

test('POST /api/sessions {cwd: repo} starts claude in the worktree', async () => {
  const root = realpathSync(tempHome());
  const repo = join(root, 'my #repo');
  mkdirSync(repo);
  const git = (...a: string[]): string => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');

  writeFileSync(join(repo, 'dirty.txt'), 'x\n');
  const r = await call('POST', '/api/sessions', json({ cwd: repo, name: 'wt test' }));
  assert.equal(r.status, 201);
  assert.equal(r.json().warning, "Uncommitted changes in my #repo aren't included in the worktree.");
  const view = r.json();
  assert.equal(view.workspace.mode, 'worktree');
  assert.match(view.workspace.branch, /^tend\//);
  assert.deepEqual(Object.keys(view.workspace).sort(), ['branch', 'mode', 'worktree']);
  const argvFile = join(home, 'sessions', view.id, 'argv.json');
  await until(() => existsSync(argvFile), 3000);
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
  assert.match(argv.find((a) => a.startsWith('--session-id='))!, /^--session-id=[0-9a-f-]{36}$/);
  const pane = execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'display', '-p', '-t', `=tend-${view.id}:`, '#{pane_current_path}'], { encoding: 'utf8' }).trim();
  assert.equal(realpathSync(pane), realpathSync(view.workspace.worktree));
});

test('POST /api/sessions rejects a non-boolean isolate', async () => {
  const r = await call('POST', '/api/sessions', json({ cwd: tempHome(), isolate: 'no' }));
  assert.equal(r.status, 400);
  assert.equal(r.json().error, 'isolate must be a boolean');
});

test('POST /api/sessions with a missing folder is a 400', async () => {
  const cwd = join(tempHome(), 'nope');
  const r = await call('POST', '/api/sessions', json({ cwd }));
  assert.equal(r.status, 400);
  assert.equal(r.json().error, `Folder not found: ${cwd}`);
});

test('POST /api/sessions with a bad body is a 400', async () => {
  const r = await call('POST', '/api/sessions', { headers: auth({ 'content-type': 'application/json' }), body: '{nope' });
  assert.equal(r.status, 400);
  const r2 = await call('POST', '/api/sessions', json({ cwd: 42 }));
  assert.equal(r2.status, 400);
});

test('typing perm into the pane reaches the SSE stream as needs_you/permission and notifies once', async () => {
  const dir = tempHome();
  const view = (await call('POST', '/api/sessions', json({ cwd: dir, name: 'perm test' }))).json();

  const events: { event: string; data: any }[] = [];
  let raw = '';
  const sse = request(srv.url + '/api/events', { headers: auth() });
  const opened = new Promise<IncomingMessage>((resolve, reject) => {
    sse.on('response', resolve);
    sse.on('error', reject);
  });
  sse.end();
  const res = await opened;
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/event-stream/);
  res.setEncoding('utf8');
  res.on('data', (c: string) => {
    raw += c;
    let i: number;
    while ((i = raw.indexOf('\n\n')) >= 0) {
      const block = raw.slice(0, i);
      raw = raw.slice(i + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) events.push({ event, data: JSON.parse(data) });
    }
  });

  try {
    await until(() => events.some((e) => e.event === 'snapshot'), 2000);
    const snap = events.find((e) => e.event === 'snapshot')!;
    assert.ok(snap.data.some((v: { id: string }) => v.id === view.id));

    await sleep(300); // let fake claude reach its readline loop
    const tmux = (...a: string[]): string => execFileSync('tmux', ['-f', '/dev/null', '-L', socket, ...a], { encoding: 'utf8' });
    tmux('send-keys', '-t', `=tend-${view.id}:`, '-l', 'perm');
    tmux('send-keys', '-t', `=tend-${view.id}:`, 'Enter');

    await until(
      () => events.some((e) => e.event === 'session' && e.data.id === view.id && e.data.state.status === 'needs_you' && e.data.state.need === 'permission'),
      3000,
    );
    await sleep(300); // the trailing Notification must not notify again
    const lines = readFileSync(join(home, 'notify.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).sessionId, view.id);
    const listed = (await call('GET', '/api/sessions', { headers: auth() })).json().find((s: { id: string }) => s.id === view.id);
    assert.equal(listed.state.status, 'needs_you');
  } finally {
    res.destroy();
    sse.destroy();
  }
});

test('POST /hook: wrong token 401, cookie is not enough, unknown or malformed session 202 with no files', async () => {
  const body = JSON.stringify({ hook_event_name: 'Stop', session_id: 'x' });
  const ct = { 'content-type': 'application/json' };
  const wrong = await call('POST', '/hook', { headers: { ...ct, 'x-tend-token': 'f'.repeat(64), 'x-tend-session': 'abcd1234' }, body });
  assert.equal(wrong.status, 401);
  const cookie = await call('POST', '/hook', { headers: { ...ct, cookie: `tend_token=${srv.token}`, 'x-tend-session': 'abcd1234' }, body });
  assert.equal(cookie.status, 401);

  const before = readdirSync(join(home, 'sessions')).sort();
  const topBefore = readdirSync(home).sort();
  for (const sid of ['abcd1234', '../x', '', 'ABCD1234']) {
    const r = await call('POST', '/hook', { headers: { ...ct, 'x-tend-token': srv.token, 'x-tend-session': sid }, body });
    assert.equal(r.status, 202, `session ${JSON.stringify(sid)}`);
    assert.deepEqual(r.json(), {});
  }
  assert.deepEqual(readdirSync(join(home, 'sessions')).sort(), before);
  assert.deepEqual(readdirSync(home).sort(), topBefore);
  assert.equal(existsSync(join(home, 'x')), false);
});

test('POST /hook for a known session answers {} and updates state', async () => {
  const view = (await call('POST', '/api/sessions', json({ cwd: tempHome() }))).json();
  const r = await call('POST', '/hook', {
    headers: { 'content-type': 'application/json', 'x-tend-token': srv.token, 'x-tend-session': view.id, 'x-tend-launch': launchOf(home, view.id) },
    body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'c' }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), {});
  const listed = (await call('GET', '/api/sessions', { headers: auth() })).json().find((s: { id: string }) => s.id === view.id);
  assert.equal(listed.state.status, 'idle');
});

test('a foreign Origin is a 403', async () => {
  const r = await call('POST', '/api/sessions', { ...json({ cwd: tempHome() }), headers: auth({ 'content-type': 'application/json', origin: 'http://evil.com' }) });
  assert.equal(r.status, 403);
  const h = await call('POST', '/hook', { headers: { origin: 'http://evil.com', 'x-tend-token': srv.token, 'x-tend-session': 'abcd1234' }, body: '{}' });
  assert.equal(h.status, 403);
});

test('a JSON body over 16 KB is a 413', async () => {
  const r = await call('POST', '/api/sessions', json({ cwd: tempHome(), name: 'x'.repeat(17 * 1024) }));
  assert.equal(r.status, 413);
});

test('unknown routes are 404 once authorised', async () => {
  assert.equal((await call('GET', '/nope', { headers: auth() })).status, 404);
  assert.equal((await call('GET', '/nope')).status, 401);
});

test('a chunked JSON body over 16 KB (no content-length) is a 413', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const r = request(srv.url + '/api/sessions', { method: 'POST', headers: auth({ 'content-type': 'application/json' }) }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    r.on('error', reject);
    for (let i = 0; i < 20; i++) r.write('x'.repeat(1024));
    r.end();
  });
  assert.equal(status, 413);
});

test('a hook body over 16 KB is still accepted, and a PermissionRequest is held until a card answers it', async () => {
  const view = (await call('POST', '/api/sessions', json({ cwd: tempHome() }))).json();
  const pending = call('POST', '/hook', {
    headers: { 'content-type': 'application/json', 'x-tend-token': srv.token, 'x-tend-session': view.id, 'x-tend-launch': launchOf(home, view.id) },
    body: JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'y'.repeat(20 * 1024) } }),
  });
  let listed: any;
  await until(async () => {
    listed = (await call('GET', '/api/sessions', { headers: auth() })).json().find((s: { id: string }) => s.id === view.id);
    return listed.decisions?.length === 1;
  }, 3000);
  assert.equal(listed.state.status, 'needs_you');
  const did = listed.decisions[0].id;
  const a = await call('POST', `/api/sessions/${view.id}/decisions/${did}`, { ...json({ action: 'deny' }), headers: auth({ 'content-type': 'application/json' }) });
  assert.equal(a.status, 200);
  const r = await pending;
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied in Tend' } } });
});

const panePath = (id: string): string =>
  execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'display', '-p', '-t', `=tend-${id}:`, '#{pane_current_path}'], {
    encoding: 'utf8',
  }).trim();

test('folders with # (tmux format chars) and a trailing ; start claude in the real folder', async () => {
  for (const leaf of ['a#Sb', 'x;', 'c#{session_name}d;']) {
    const dir = join(tempHome(), leaf);
    mkdirSync(dir);
    const r = await call('POST', '/api/sessions', json({ cwd: dir }));
    assert.equal(r.status, 201, `${leaf}: ${r.body}`);
    const { id } = r.json();
    await until(() => existsSync(join(home, 'sessions', id, 'argv.json')), 3000);
    assert.equal(panePath(id), realpathSync(dir), leaf);
  }
});

test('names ending in ; or a backslash-; reach claude intact as --name', async () => {
  for (const name of ['n;', 'a\\;', 'b\\\\;', 'mid;dle;;']) {
    const r = await call('POST', '/api/sessions', json({ cwd: tempHome(), name }));
    assert.equal(r.status, 201, `${name}: ${r.body}`);
    const { id } = r.json();
    const file = join(home, 'sessions', id, 'argv.json');
    await until(() => existsSync(file), 3000);
    const argv = JSON.parse(readFileSync(file, 'utf8')) as string[];
    const at = argv.findIndex((a) => a.startsWith('--name='));
    assert.equal(argv[at], `--name=${name}`);
    assert.match(argv[at + 1]!, /^--session-id=/, 'nothing after --name was split off');
  }
});
