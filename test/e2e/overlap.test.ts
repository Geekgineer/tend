import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killSocket, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = tempHome();
const notifyFile = join(home, 'notify.jsonl');
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
const git = (dir: string, ...a: string[]): string =>
  execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

before(async () => {
  srv = await startServer({ TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'stub', TEND_CLAUDE_BIN: FAKE });
});

after(async () => {
  await srv?.stop();
  killSocket(socket);
});

/** A temp repo under a `my #repo` folder, ignoring .env and node_modules/, with one commit. */
function makeRepo(): string {
  const repo = join(realpathSync(tempHome()), 'my #repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

type Git = { branch: string | null; changed: string[]; uncommitted: number };
type View = {
  id: string; name: string; state: { status: string }; paused: boolean; workspace: { mode: string; worktree: string };
  git?: Git; overlap?: { files: string[]; with: string[] };
};

/** Wait until fake claude has drawn its prompt (its readline loop is up). */
async function ready(id: string): Promise<void> {
  await until(() => {
    try {
      return tmux('capture-pane', '-p', '-t', `=tend-${id}:`).includes('fake claude');
    } catch {
      return false;
    }
  }, 5000, `fake claude in tend-${id}`);
}

function type(id: string, text: string): void {
  tmux('send-keys', '-t', `=tend-${id}:`, '-l', text);
  tmux('send-keys', '-t', `=tend-${id}:`, 'Enter');
}

async function create(cwd: string, name: string, isolate = true): Promise<View> {
  const r = await call('POST', '/api/sessions', { cwd, name, isolate });
  assert.equal(r.status, 201, r.body);
  const v = r.json() as View;
  await ready(v.id);
  return v;
}

const viewOf = async (id: string): Promise<View | undefined> =>
  ((await call('GET', '/api/sessions')).json() as View[]).find((s) => s.id === id);
const notifications = (): { sessionId: string; title: string; body: string }[] =>
  existsSync(notifyFile) ? readFileSync(notifyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

test('two worktree sessions editing src/x.ts are both flagged within 2 s, with exactly one notification', async () => {
  const repo = makeRepo();
  const before = notifications().length;
  const a = await create(repo, 'first');
  const b = await create(repo, 'second');
  type(a.id, 'edit src/x.ts');
  type(b.id, 'edit src/x.ts');
  await until(async () => {
    const [va, vb] = [await viewOf(a.id), await viewOf(b.id)];
    return va?.overlap?.with[0] === b.id && vb?.overlap?.with[0] === a.id;
  }, 2000, 'both sessions flagged');
  const va = (await viewOf(a.id))!;
  assert.deepEqual(va.overlap, { files: ['src/x.ts'], with: [b.id] });
  assert.equal(va.state.status, 'idle');
  assert.equal((await viewOf(b.id))!.state.status, 'idle');
  assert.deepEqual(va.git?.changed, ['src/x.ts']);
  await sleep(600);
  const added = notifications().slice(before);
  assert.equal(added.length, 1, JSON.stringify(added));
  const [lo, hi] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.equal(added[0]!.title, `${lo!.name} overlaps ${hi!.name}`);
  assert.equal(added[0]!.body, 'Both changed: src/x.ts');
});

test('an in-place session in the same repo never overlaps', async () => {
  const repo = makeRepo();
  const w = await create(repo, 'isolated');
  const p = await create(repo, 'inplace', false);
  type(w.id, 'edit src/y.ts');
  type(p.id, 'edit src/y.ts');
  await until(async () => ((await viewOf(w.id))?.git?.changed ?? []).includes('src/y.ts'), 3000, 'worktree facts');
  await until(async () => ((await viewOf(p.id))?.git?.changed ?? []).includes('src/y.ts'), 3000, 'in-place facts');
  await sleep(500);
  assert.equal((await viewOf(w.id))!.overlap, undefined);
  assert.equal((await viewOf(p.id))!.overlap, undefined);
});
