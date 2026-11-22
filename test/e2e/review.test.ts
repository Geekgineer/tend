import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killSocket, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = realpathSync(tempHome());
let srv: Awaited<ReturnType<typeof startServer>>;

type Res = { status: number; headers: Record<string, unknown>; body: Buffer; json: () => any };
function call(method: string, path: string, body?: string, headers: Record<string, string> = { 'x-tend-token': '' }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
    if (h['x-tend-token'] === '') h['x-tend-token'] = srv.token;
    const r = request(srv.url + path, { method, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        resolve({ status: res.statusCode!, headers: res.headers, body: b, json: () => JSON.parse(b.toString('utf8')) });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}
async function until<T>(fn: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const view = async (id: string): Promise<any> => ((await call('GET', '/api/sessions')).json() as any[]).find((s) => s.id === id);
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');

let repo = '';
before(async () => {
  srv = await startServer({ TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'off', TEND_CLAUDE_BIN: FAKE });
  repo = join(home, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  writeFileSync(join(repo, 'README.md'), '# Hello\n\nOld intro.\n');
  writeFileSync(join(repo, 'docs', 'pic.png'), PNG);
  writeFileSync(join(repo, 'code.ts'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(repo, '.gitignore'), '*.log\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
});
after(async () => {
  await srv?.stop();
  killSocket(socket);
});

test('the tree lists the worktree\'s files with change stats; reads are inside the session only', async () => {
  const v = (await call('POST', '/api/sessions', JSON.stringify({ cwd: repo, name: 'rev' }))).json();
  const wt = v.workspace.worktree;
  writeFileSync(join(wt, 'README.md'), '# Hello\n\nNew intro.\n\n## More\n');
  writeFileSync(join(wt, 'notes.md'), 'fresh\n');
  writeFileSync(join(wt, 'debug.log'), 'ignored\n');
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  lines[29] = 'line thirty';
  writeFileSync(join(wt, 'code.ts'), lines.join('\n') + '\n');
  await until(async () => ((await view(v.id)).git?.changed.length === 3 ? true : undefined), 15_000, 'git facts');

  const t = (await call('GET', `/api/sessions/${v.id}/tree`)).json();
  assert.equal(t.git, true);
  assert.deepEqual(t.files, ['.gitignore', 'README.md', 'code.ts', 'docs/pic.png', 'notes.md']);
  const by = Object.fromEntries(t.changes.map((c: any) => [c.path, c]));
  assert.deepEqual([by['README.md'].status, by['README.md'].add, by['README.md'].del], ['M', 3, 1]);
  assert.deepEqual([by['notes.md'].status, by['notes.md'].add], ['A', 1]);

  const now = (await call('GET', `/api/sessions/${v.id}/file?path=README.md`)).json();
  assert.match(now.text, /New intro/);
  assert.match(now.fp, /^\d+:\d+$/);
  const start = (await call('GET', `/api/sessions/${v.id}/file?path=README.md&at=start`)).json();
  assert.match(start.text, /Old intro/);
  assert.equal((await call('GET', `/api/sessions/${v.id}/file?path=notes.md&at=start`)).json().missing, true);

  // a diff with the whole file as context
  const short = (await call('GET', `/api/sessions/${v.id}/diff?path=code.ts`)).json();
  const full = (await call('GET', `/api/sessions/${v.id}/diff?path=code.ts&context=full`)).json();
  assert.ok(!/^ line 1$/m.test(short.diff));
  assert.match(full.diff, /^ line 1$/m);

  // images come back inert; other files are not served raw
  const img = await call('GET', `/api/sessions/${v.id}/raw?path=docs/pic.png`);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.match(String(img.headers['content-security-policy']), /sandbox/);
  assert.equal(img.headers['x-content-type-options'], 'nosniff');
  assert.equal((await call('GET', `/api/sessions/${v.id}/raw?path=README.md`)).status, 415);

  // no way out of the folder
  for (const bad of ['../repo/README.md', '/etc/hosts', '.git/config', 'docs/../../x', '']) {
    assert.equal((await call('GET', `/api/sessions/${v.id}/file?path=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
  const outside = mkdtempSync(join(tmpdir(), 'tend-out-'));
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
  writeFileSync(join(outside, 'secret.png'), PNG);
  symlinkSync(join(outside, 'secret.txt'), join(wt, 'link.txt'));
  symlinkSync(join(outside, 'secret.png'), join(wt, 'link.png'));
  assert.equal((await call('GET', `/api/sessions/${v.id}/file?path=link.txt`)).status, 404);
  assert.equal((await call('GET', `/api/sessions/${v.id}/raw?path=link.png`)).status, 404);
  assert.equal((await call('GET', `/api/sessions/${v.id}/file?path=nope.md`)).status, 404);
  assert.equal((await call('GET', `/api/sessions/${v.id}/file?path=README.md&at=start&x=1`)).status, 200);

  // the UI token only (the hook token can't read files)
  const hookToken = execFileSync('cat', [join(home, 'hook-token')], { encoding: 'utf8' }).trim();
  assert.equal((await call('GET', `/api/sessions/${v.id}/tree`, undefined, { 'x-tend-token': hookToken })).status, 401);
  assert.equal((await call('GET', `/api/sessions/${v.id}/file?path=README.md`, undefined, { 'x-tend-token': 'nope' })).status, 401);
});

test('a folder outside git: the tree is a walk, nothing counts as changed, no "at start"', async () => {
  const dir = join(home, 'plain');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'a.md'), '# A\n');
  writeFileSync(join(dir, 'sub', 'b.txt'), 'b\n');
  const v = (await call('POST', '/api/sessions', JSON.stringify({ cwd: dir, name: 'plain', isolate: false }))).json();
  const t = (await call('GET', `/api/sessions/${v.id}/tree`)).json();
  assert.equal(t.git, false);
  assert.deepEqual(t.changes, []);
  assert.ok(t.files.includes('a.md') && t.files.includes('sub/b.txt'));
  assert.equal((await call('GET', `/api/sessions/${v.id}/file?path=a.md`)).json().text, '# A\n');
  assert.equal((await call('GET', `/api/sessions/${v.id}/file?path=a.md&at=start`)).status, 404);
});

test('a review goes to Claude as one message; never while Claude waits for an answer', async () => {
  const v = (await call('POST', '/api/sessions', JSON.stringify({ cwd: repo, name: 'say', isolate: false }))).json();
  await until(async () => ((await view(v.id)).state.status === 'idle' ? true : undefined), 10_000, 'idle');
  const screen = async () => Buffer.from((await call('GET', `/api/sessions/${v.id}/snapshot`)).body.toString(), 'base64').toString('utf8');
  assert.equal((await call('POST', `/api/sessions/${v.id}/say`, JSON.stringify({ text: '' }))).status, 400);
  const ok = await call('POST', `/api/sessions/${v.id}/say`, JSON.stringify({ text: 'Review comments:\n- a.ts:1 fix\x1b[201~ this' }));
  assert.equal(ok.status, 200);
  await until(async () => ((await screen()).includes('fix[201~ this') ? true : undefined), 5000, 'the review on screen, control characters gone');
  // a held permission card: the Enter would answer it
  await new Promise((r) => {
    const req = request(srv.url + `/api/sessions/${v.id}/keys`, { method: 'POST', headers: { 'x-tend-token': srv.token } }, (res) => (res.resume(), res.on('end', r)));
    req.end('perm\r');
  });
  await until(async () => ((await view(v.id)).decisions?.length ? true : undefined), 5000, 'a card');
  const refused = await call('POST', `/api/sessions/${v.id}/say`, JSON.stringify({ text: 'hello' }));
  assert.equal(refused.status, 409);
  assert.match(refused.json().error, /answer it first/);
});
