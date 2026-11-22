import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync as readF, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killSocket, launchOf, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = tempHome();
let srv: Awaited<ReturnType<typeof startServer>>;

type Res = { status: number; body: string; json: () => any };

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request(
      srv.url + path,
      { method, headers: { 'x-tend-token': srv.token, 'content-type': 'application/json', ...headers } },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: b, json: () => JSON.parse(b) }));
      },
    );
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms: number, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}
const tmux = (...a: string[]): string => execFileSync('tmux', ['-f', '/dev/null', '-L', socket, ...a], { encoding: 'utf8' });
const env = { TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'stub', TEND_CLAUDE_BIN: FAKE };
const statusOf = async (id: string): Promise<string | undefined> =>
  ((await call('GET', '/api/sessions')).json() as { id: string; state: { status: string } }[]).find((s) => s.id === id)?.state.status;

before(async () => {
  srv = await startServer(env);
});

after(async () => {
  await srv?.stop();
  killSocket(socket);
});

test('restart and reconcile', async (t) => {
  const mk = async (name: string): Promise<string> => {
    const r = await call('POST', '/api/sessions', { cwd: home, name });
    assert.equal(r.status, 201);
    return r.json().id;
  };
  const a = await mk('alpha');
  const b = await mk('beta');

  await t.test('a restarted server rebuilds state from the store without re-notifying', async () => {
    const h = (id: string) => ({ 'x-tend-session': id, 'x-tend-launch': launchOf(home, id) });
    // held until answered; the restart below drops the connection (Claude would show its own dialog)
    const held = call('POST', '/hook', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, h(a)).then(
      () => 'answered',
      () => 'dropped',
    );
    await until(async () => (await statusOf(a)) === 'needs_you', 3000, 'needs_you');
    assert.equal(((await call('GET', '/api/sessions')).json() as any[]).find((s) => s.id === a).decisions.length, 1);
    const notifyFile = join(home, 'notify.jsonl');
    const { readFileSync, existsSync } = await import('node:fs');
    const lines = () => (existsSync(notifyFile) ? readFileSync(notifyFile, 'utf8').split('\n').filter(Boolean).length : 0);
    assert.equal(lines(), 1);

    await srv.stop(); // tmux keeps running
    assert.equal(await held, 'dropped', 'Tend never answers a held request on its way down');
    srv = await startServer(env);
    const list = (await call('GET', '/api/sessions')).json() as { id: string; state: { status: string }; decisions?: unknown[] }[];
    assert.equal(list.length, 2);
    assert.equal(list.find((s) => s.id === a)?.state.status, 'needs_you');
    assert.equal(list.find((s) => s.id === a)?.decisions, undefined, 'after a restart the card says: answer in the terminal');
    assert.notEqual(list.find((s) => s.id === b)?.state.status, 'ended');
    assert.equal(lines(), 1, 'replay must not notify');
  });

  await t.test('a session killed in tmux becomes ended within 3 s', async () => {
    tmux('kill-session', '-t', `=tend-${b}`);
    await until(async () => (await statusOf(b)) === 'ended', 3000, 'ended');
    assert.notEqual(await statusOf(a), 'ended');
  });

  await t.test('a stored session whose tmux session vanished while down boots as ended', async () => {
    await srv.stop();
    tmux('kill-session', '-t', `=tend-${a}`);
    srv = await startServer(env);
    assert.equal(await statusOf(a), 'ended');
    assert.equal(await statusOf(b), 'ended');
  });

  await t.test('GET /term for a session whose tmux is gone is 404 before any SSE headers', async () => {
    const r = await call('GET', `/api/sessions/${a}/term`);
    assert.equal(r.status, 404);
    assert.match(String(r.json().error), /not running/i);
  });
});

const git = (dir: string, ...a: string[]): string =>
  execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function makeRepo(): string {
  const repo = join(realpathSync(tempHome()), 'my #repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

type V = { id: string; state: { status: string }; paused: boolean; git?: unknown; overlap?: { with: string[] } };
const views = async (): Promise<V[]> => (await call('GET', '/api/sessions')).json() as V[];

test('after restart, with one session paused and one archived, facts and overlap come back silently', async () => {
  const repo = makeRepo();
  const mk = async (name: string): Promise<string> => {
    const r = await call('POST', '/api/sessions', { cwd: repo, name });
    assert.equal(r.status, 201, r.body);
    const id = r.json().id as string;
    await until(() => {
      try {
        return tmux('capture-pane', '-p', '-t', `=tend-${id}:`).includes('fake claude');
      } catch {
        return false;
      }
    }, 5000, 'fake claude prompt');
    return id;
  };
  const type = (id: string, text: string): void => {
    tmux('send-keys', '-t', `=tend-${id}:`, '-l', text);
    tmux('send-keys', '-t', `=tend-${id}:`, 'Enter');
  };
  const a = await mk('ra');
  const b = await mk('rb');
  const paused = await mk('rp');
  const archived = await mk('rx');
  const resumed = await mk('rr');
  type(a, 'edit src/z.ts');
  type(b, 'edit src/z.ts');
  await until(async () => {
    const v = await views();
    return v.find((s) => s.id === a)?.overlap?.with[0] === b;
  }, 5000, 'overlap before restart');
  assert.equal((await call('POST', `/api/sessions/${paused}/pause`)).status, 200);
  assert.equal((await call('POST', `/api/sessions/${archived}/archive`)).status, 204);
  assert.equal((await call('POST', `/api/sessions/${resumed}/pause`)).status, 200);
  assert.equal((await call('POST', `/api/sessions/${resumed}/resume`)).status, 200);
  await until(async () => (await views()).find((s) => s.id === resumed)?.git !== undefined, 5000, 'resumed facts');

  const notifyFile = join(home, 'notify.jsonl');
  const lines = (): number => readF(notifyFile, 'utf8').split('\n').filter(Boolean).length;
  const briefings = async (): Promise<unknown[]> =>
    Promise.all([a, b, paused, resumed].map(async (id) => (await call('GET', `/api/sessions/${id}/briefing`)).json()));
  const pre = await briefings();
  const preLines = lines();
  const preViews = await views();

  await srv.stop();
  srv = await startServer(env);

  const post = await views();
  assert.equal(post.find((s) => s.id === archived), undefined);
  assert.equal(post.find((s) => s.id === paused)?.paused, true);
  assert.equal(post.find((s) => s.id === paused)?.git, undefined);
  assert.deepEqual(post.find((s) => s.id === a)?.overlap, preViews.find((s) => s.id === a)?.overlap);
  assert.deepEqual(post.find((s) => s.id === a)?.git, preViews.find((s) => s.id === a)?.git);
  assert.equal(post.find((s) => s.id === b)?.overlap?.with[0], a);
  assert.notEqual(post.find((s) => s.id === resumed)?.state.status, 'ended');
  assert.deepEqual(await briefings(), pre);
  await sleep(500);
  assert.equal(lines(), preLines, 'boot refresh must not notify');
});
