import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { killSocket, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = realpathSync(tempHome());
let srv: Awaited<ReturnType<typeof startServer>>;

type Res = { status: number; headers: Record<string, unknown>; body: Buffer; json: () => any };
function call(method: string, path: string, body?: Buffer | string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request(srv.url + path, { method, headers: { 'x-tend-token': srv.token, ...headers } }, (res) => {
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
async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}
function png(w: number, h: number): Buffer {
  const chunk = (t: string, d: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([head, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((w * 3 + 1) * h))), chunk('IEND', Buffer.alloc(0))]);
}
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const view = async (id: string): Promise<any> => ((await call('GET', '/api/sessions')).json() as any[]).find((s) => s.id === id);
const screen = async (id: string) => Buffer.from((await call('GET', `/api/sessions/${id}/snapshot`)).body.toString(), 'base64').toString('utf8');
const upload = (id: string, name: string, data: Buffer) => call('POST', `/api/sessions/${id}/attachments`, data, { 'x-file-name': encodeURIComponent(name) });

let repo = '';
before(async () => {
  srv = await startServer({ TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'off', TEND_CLAUDE_BIN: FAKE });
  repo = join(home, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
});
after(async () => {
  await srv?.stop();
  killSocket(socket);
});

test('an image dropped on a worktree session lands in .tend/attachments, excluded from git, and its path is pasted (not sent)', async () => {
  const v = (await call('POST', '/api/sessions', JSON.stringify({ cwd: repo, name: 'wt' }), { 'content-type': 'application/json' })).json();
  await new Promise((r) => setTimeout(r, 600));
  const r = await upload(v.id, 'Login bug.png', png(40, 20));
  assert.equal(r.status, 201, r.body.toString());
  const a = r.json();
  assert.equal(a.kind, 'png');
  assert.match(a.insert, /^"\.tend\/attachments\/\d{8}-\d{4}-login-bug\.png" $/);
  const file = join(v.workspace.worktree, JSON.parse(a.insert.trim()));
  assert.ok(existsSync(file));
  assert.equal(git(v.workspace.worktree, 'status', '--porcelain'), '', 'nothing to commit');
  assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.tend\/$/m);
  await until(async () => (await screen(v.id)).includes('login-bug.png') || undefined, 3000, 'path at the prompt');
  assert.notEqual((await view(v.id)).state.status, 'working', 'nothing was submitted');
  const list = (await call('GET', `/api/sessions/${v.id}/attachments`)).json();
  assert.equal(list[0].name, a.name);
  const f = await call('GET', `/api/sessions/${v.id}/attachments/${a.name}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers['content-type'], 'image/png');
  assert.match(String(f.headers['content-security-policy']), /sandbox/);
  assert.equal(f.headers['x-content-type-options'], 'nosniff');
  assert.equal((await call('GET', `/api/sessions/${v.id}/attachments/..%2F..%2Fa.txt`)).status, 404);
  assert.equal((await call('GET', `/api/sessions/${v.id}/attachments/nope.png`)).status, 404);
});

test('in place: Tend\'s attachments folder, --add-dir at launch, absolute path; archive removes it', async () => {
  const dir = join(home, 'plain');
  mkdirSync(dir);
  const v = (await call('POST', '/api/sessions', JSON.stringify({ cwd: dir, name: 'ip', isolate: false }), { 'content-type': 'application/json' })).json();
  const att = join(home, 'attachments', v.id);
  await until(() => existsSync(join(home, 'sessions', v.id, 'argv.json')) || undefined, 3000, 'argv');
  const argv = JSON.parse(readFileSync(join(home, 'sessions', v.id, 'argv.json'), 'utf8'));
  assert.deepEqual(argv.slice(argv.indexOf('--add-dir'), argv.indexOf('--add-dir') + 2), ['--add-dir', att]);
  const a = (await upload(v.id, 'notes.md', Buffer.from('# hi'))).json();
  assert.equal(a.insert, `${JSON.stringify(join(att, a.name))} `);
  assert.equal((await call('POST', `/api/sessions/${v.id}/archive`)).status, 204);
  assert.equal(existsSync(att), false);
});

test('video is refused; over 25 MB is refused', async () => {
  const v = (await call('POST', '/api/sessions', JSON.stringify({ cwd: repo, name: 'refuse', isolate: false }), { 'content-type': 'application/json' })).json();
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
  const r = await upload(v.id, 'clip.mp4', mp4);
  assert.equal(r.status, 400);
  assert.match(r.json().error, /can't watch video/);
  assert.equal((await upload(v.id, 'big.bin', Buffer.alloc(25 * 1024 * 1024 + 1))).status, 413);
});

test('Review diffs: a changed file shows its diff; other paths are refused', async () => {
  const v = (await call('POST', '/api/sessions', JSON.stringify({ cwd: repo, name: 'diffy' }), { 'content-type': 'application/json' })).json();
  writeFileSync(join(v.workspace.worktree, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(v.workspace.worktree, 'new.txt'), 'fresh\n');
  await until(async () => ((await view(v.id)).git?.changed.length === 2 ? true : undefined), 15_000, 'git facts');
  const d = (await call('GET', `/api/sessions/${v.id}/diff?path=a.txt`)).json();
  assert.match(d.diff, /^\+two$/m);
  assert.equal(d.binary, false);
  const n = (await call('GET', `/api/sessions/${v.id}/diff?path=new.txt`)).json();
  assert.match(n.diff, /^\+fresh$/m);
  assert.equal((await call('GET', `/api/sessions/${v.id}/diff?path=../repo/a.txt`)).status, 400);
  // an untracked symlink shows its target, never the file it points to
  const { symlinkSync } = await import('node:fs');
  symlinkSync('/etc/hosts', join(v.workspace.worktree, 'sneaky'));
  await until(async () => ((await view(v.id)).git?.changed.includes('sneaky') ? true : undefined), 15_000, 'symlink in facts');
  const l = (await call('GET', `/api/sessions/${v.id}/diff?path=sneaky`)).json();
  assert.match(l.diff, /^\+\/etc\/hosts$/m);
  assert.ok(!/localhost/.test(l.diff), 'never the target content');
  assert.equal((await call('GET', `/api/sessions/${v.id}/diff?path=README.md`)).status, 404);
});

test('listing a paused session\'s attachments never recreates its worktree (Resume stays possible)', async () => {
  const v = (await call('POST', '/api/sessions', JSON.stringify({ cwd: repo, name: 'pausable' }), { 'content-type': 'application/json' })).json();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await upload(v.id, 'n.md', Buffer.from('# hi'))).status, 201);
  assert.equal((await call('POST', `/api/sessions/${v.id}/pause`)).status, 200);
  assert.equal(existsSync(v.workspace.worktree), false);
  assert.equal((await call('GET', `/api/sessions/${v.id}/attachments`)).status, 200);
  assert.equal(existsSync(v.workspace.worktree), false, 'the list must not create the folder');
  const r = await call('POST', `/api/sessions/${v.id}/resume`);
  assert.equal(r.status, 200, r.body.toString());
  assert.ok(existsSync(join(v.workspace.worktree, '.tend', 'attachments')), 'attachments come back with the worktree');
});
