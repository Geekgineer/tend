import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { killSocket, startServer, tempHome, uniqueSocket } from '../helpers.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renderBriefing } from '../../ui/briefing.js';
import { archiveQuestion } from '../../ui/header.js';
import { recentFolders } from '../../ui/list.js';
import { stopFolderPanel } from '../../src/choose-folder.ts';

const socket = uniqueSocket();
let srv: Awaited<ReturnType<typeof startServer>>;

type Res = { status: number; headers: IncomingMessage['headers']; body: string };

function get(path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    // options form: `path` goes over the wire verbatim (a URL string would normalise away '..')
    const r = request({ host: '127.0.0.1', port: srv.port, path, method: 'GET', headers }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    r.end();
  });
}

function post(path: string, body: unknown, headers: Record<string, string>): Promise<Res> {
  return new Promise((resolve, reject) => {
    const h = { 'content-type': 'application/json', origin: `http://127.0.0.1:${srv.port}`, ...headers };
    const r = request({ host: '127.0.0.1', port: srv.port, path, method: 'POST', headers: h }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });
}

const cookie = (): Record<string, string> => ({ cookie: `tend_token=${srv.token}` });

before(async () => {
  srv = await startServer({ TEND_HOME: tempHome(), TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'off' });
});

after(async () => {
  await srv?.stop();
  killSocket(socket);
});

test('GET /?key=<token> serves the app page and sets the cookie', async () => {
  const r = await get(`/?key=${srv.token}`);
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /^text\/html/);
  assert.ok(r.body.includes('tend.'), 'page carries the wordmark');
  const set = String(r.headers['set-cookie']);
  assert.match(set, new RegExp(`tend_token=${srv.token}`));
  assert.match(set, /HttpOnly/);
});

test('GET / without a token is refused', async () => {
  const r = await get('/');
  assert.equal(r.status, 401);
});

test('/vendor/xterm.js is served as JavaScript', async () => {
  const r = await get('/vendor/xterm.js', cookie());
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /^application\/javascript/);
  assert.ok(r.body.length > 1000);
});

test('the other vendor files and UI modules are served', async () => {
  for (const [path, type] of [
    ['/vendor/xterm.css', /^text\/css/],
    ['/vendor/addon-fit.js', /^application\/javascript/],
    ['/ui/app.js', /^application\/javascript/],
    ['/ui/api.js', /^application\/javascript/],
    ['/ui/list.js', /^application\/javascript/],
    ['/ui/terminal.js', /^application\/javascript/],
    ['/ui/briefing.js', /^application\/javascript/],
    ['/ui/header.js', /^application\/javascript/],
    ['/ui/styles.css', /^text\/css/],
  ] as const) {
    const r = await get(path, cookie());
    assert.equal(r.status, 200, path);
    assert.match(String(r.headers['content-type']), type, path);
  }
});

test('static files come from a fixed map, never from the request path', async () => {
  for (const path of ['/ui/../src/server.ts', '/ui/%2e%2e/package.json', '/ui/globals.d.ts', '/vendor/xterm.js.map', '/ui/']) {
    const r = await get(path, cookie());
    assert.equal(r.status, 404, path);
  }
});

test('the app page loads nothing from the network (no web fonts)', async () => {
  const page = await get(`/?key=${srv.token}`);
  const css = await get('/ui/styles.css', cookie());
  for (const body of [page.body, css.body]) {
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(body), 'no Google Fonts');
    assert.ok(!/<link[^>]+href="https?:/i.test(body) && !/@import|url\(\s*["']?https?:/i.test(body), 'no remote stylesheet');
    assert.ok(!/<script[^>]+src="https?:/i.test(body), 'no remote script');
  }
});

test('/ui/briefing.js is served with the token and 401 without', async () => {
  const ok = await get('/ui/briefing.js', cookie());
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['content-type']), /^application\/javascript/);
  assert.match(ok.body, /export function renderBriefing/);
  const no = await get('/ui/briefing.js');
  assert.equal(no.status, 401);
});

test('index.html has the Own worktree checkbox checked', async () => {
  const r = await get(`/?key=${srv.token}`);
  const box = /<input[^>]*id="newIso"[^>]*>/.exec(r.body);
  assert.ok(box, 'checkbox present');
  assert.match(box[0], /type="checkbox"/);
  assert.match(box[0], /\schecked\b/);
  assert.match(r.body, /Own worktree/);
});

/** Just enough DOM for renderBriefing; innerHTML is a trap, so any HTML parsing fails the test. */
class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  dataset: Record<string, string> = {};
  className = '';
  hidden = false;
  open = true;
  title = '';
  type = '';
  #text = '';
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.#text = v;
    this.children = [];
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML used');
  }
  append(...nodes: (FakeEl | string)[]): void {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const t = new FakeEl('#text');
        t.textContent = n;
        this.children.push(t);
      } else this.children.push(n);
    }
  }
  replaceChildren(...nodes: (FakeEl | string)[]): void {
    this.#text = '';
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(): void {}
  setAttribute(): void {}
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

test('the briefing HTML-escapes event text', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const created: string[] = [];
  const doc = {
    createElement: (tag: string) => {
      created.push(tag.toLowerCase());
      return new FakeEl(tag);
    },
  };
  Object.assign(globalThis, { document: doc });
  try {
    const root = new FakeEl('details');
    const now = Date.now();
    renderBriefing(root as unknown as HTMLElement, {
      goal: evil,
      instructions: [{ ts: now, text: evil }],
      done: [{ ts: now, text: evil, files: [evil] }],
      files: [evil],
      working: [evil],
      state: { status: 'idle', since: now },
    });
    assert.ok(!created.includes('img'), 'no img element created');
    assert.ok(!root.all().some((e) => e.tagName === 'IMG'), 'no img element in the tree');
    assert.ok(root.textContent.includes(evil), 'the prompt shows as text');
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
});

test('GET /api/repo tells the dialog whether a folder is a git repo with commits', async () => {
  const root = realpathSync(tempHome());
  const git = (dir: string, ...a: string[]): string => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  const unborn = join(root, 'unborn');
  const full = join(root, 'my #repo');
  for (const d of [unborn, full]) {
    mkdirSync(d);
    git(d, 'init', '-q', '-b', 'main');
  }
  git(full, 'config', 'user.name', 'T');
  git(full, 'config', 'user.email', 't@example.com');
  writeFileSync(join(full, 'a'), 'a\n');
  git(full, 'add', '-A');
  git(full, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one');
  const repo = async (p: string, headers = cookie()) => get(`/api/repo?path=${encodeURIComponent(p)}`, headers);

  assert.equal((await repo(full, {})).status, 401);
  assert.equal((await repo('/' + 'x'.repeat(4096))).status, 400);
  assert.equal((await get('/api/repo', cookie())).status, 400);
  for (const [p, want] of [
    [root, { git: false, commits: false }],
    [join(root, 'missing'), { git: false, commits: false }],
    [unborn, { git: true, commits: false }],
    [full, { git: true, commits: true }],
    [join(full, '.git', '..'), { git: true, commits: true }],
  ] as const) {
    const r = await repo(p);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), want, p);
  }
});

test('POST /api/choose-folder returns the folder picked in the macOS window, or null on cancel', async () => {
  const root = realpathSync(tempHome());
  const fake = join(root, 'osascript');
  // a fake helper speaking the folder-panel protocol: "ready", then one answer line per request
  // (the start folder with a trailing slash, or an empty line when TEND_FAKE_CANCEL is set)
  writeFileSync(fake, '#!/bin/sh\necho ready\nwhile read -r l; do if [ -n "$TEND_FAKE_CANCEL" ]; then echo; else echo "$l/"; fi; done\n', { mode: 0o755 });
  process.env.TEND_OSASCRIPT = fake;
  try {
    const pick = (body: unknown, headers = cookie()) => post('/api/choose-folder', body, headers);
    assert.equal((await pick({}, {})).status, 401);
    assert.equal((await pick({ start: 5 })).status, 400);
    const r = await pick({ start: root });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { path: root });
    const missing = JSON.parse((await pick({ start: join(root, 'nope') })).body);
    assert.equal(missing.path, homedir()); // a start that isn't a folder opens at home
    stopFolderPanel(); // the helper reads TEND_FAKE_CANCEL when it starts
    process.env.TEND_FAKE_CANCEL = '1';
    assert.deepEqual(JSON.parse((await pick({ start: root })).body), { path: null });
  } finally {
    stopFolderPanel();
    delete process.env.TEND_OSASCRIPT;
    delete process.env.TEND_FAKE_CANCEL;
  }
});

test('a folder window that never answers (opened out of sight) can be cancelled from the page', async () => {
  const root = realpathSync(tempHome());
  const fake = join(root, 'osascript');
  // says "ready", then never answers: like a panel hidden on another desktop
  writeFileSync(fake, '#!/bin/sh\necho ready\nwhile read -r l; do sleep 3600; done\n', { mode: 0o755 });
  process.env.TEND_OSASCRIPT = fake;
  try {
    stopFolderPanel();
    assert.deepEqual(JSON.parse((await post('/api/choose-folder/cancel', {}, cookie())).body), { cancelled: false });
    const pending = post('/api/choose-folder', { start: root }, cookie());
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(JSON.parse((await post('/api/choose-folder', { start: root }, cookie())).body).error, 'The folder window is already open.');
    assert.equal((await post('/api/choose-folder/cancel', {}, {})).status, 401);
    assert.deepEqual(JSON.parse((await post('/api/choose-folder/cancel', {}, cookie())).body), { cancelled: true });
    assert.deepEqual(JSON.parse((await pending).body), { path: null }, 'the stuck choose ends as a cancel');
    // and the next Choose starts a fresh helper
    writeFileSync(fake, '#!/bin/sh\necho ready\nwhile read -r l; do echo "$l"; done\n', { mode: 0o755 });
    assert.deepEqual(JSON.parse((await post('/api/choose-folder', { start: root }, cookie())).body), { path: root });
  } finally {
    stopFolderPanel();
    delete process.env.TEND_OSASCRIPT;
  }
});

test('recent folders are distinct and newest first', () => {
  const v = (cwd: string, createdAt: number) => ({ cwd, createdAt });
  assert.deepEqual(recentFolders([v('/a', 1), v('/b', 3), v('/a', 4), v('/c', 2)]), ['/a', '/b', '/c']);
  assert.deepEqual(recentFolders([v('/a', 1), v('/b', 2), v('/c', 3)], 2), ['/c', '/b']);
});

test('the archive question of a paused worktree session says where its set-aside files stay', () => {
  const ws = { mode: 'worktree', branch: 'tend/x-ab12cd34', worktree: '/w' };
  const v = (paused: boolean) => ({ id: 'ab12cd34', name: 'x', paused, workspace: ws }) as any;
  assert.equal(archiveQuestion(v(false)), 'Archive x? Its worktree is removed; the branch tend/x-ab12cd34 is kept.');
  assert.equal(
    archiveQuestion(v(true)),
    'Archive x? Its worktree is removed; the branch tend/x-ab12cd34 is kept. Set-aside ignored files stay in ~/.tend/paused/ab12cd34.',
  );
});
