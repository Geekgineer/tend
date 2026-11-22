import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killSocket, launchOf, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = tempHome();
const work = join(tempHome(), '.claude-work');
const spare = join(tempHome(), '.claude-spare');
for (const d of [work, spare]) mkdirSync(d, { recursive: true });
const env = { TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'stub', TEND_CLAUDE_BIN: FAKE, TEND_ACCOUNTS: `${work}:${spare}` };
let srv: Awaited<ReturnType<typeof startServer>>;

type Res = { status: number; json: () => any };
function call(method: string, path: string, body?: unknown, raw?: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request(srv.url + path, { method, headers: { 'x-tend-token': srv.token, 'content-type': 'application/json', ...headers } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: () => JSON.parse(b) }));
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
const usage = async (): Promise<any[]> => (await call('GET', '/api/usage')).json().accounts;
const mk = async (name: string, extra: Record<string, unknown> = {}): Promise<any> => {
  const r = await call('POST', '/api/sessions', { cwd: home, name, isolate: false, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json()));
  return r.json();
};

before(async () => {
  srv = await startServer(env);
  // the user's own status line, in the default account's settings
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'cat >/dev/null; echo USER-SL' } }));
});
after(async () => {
  await srv?.stop();
  killSocket(socket);
});

test('the wrapper reports context to Tend and still prints the user\'s own status line', async () => {
  const v = await mk('ctx', { account: process.env.CLAUDE_CONFIG_DIR });
  const settings = JSON.parse(readFileSync(join(home, 'sessions', v.id, 'settings.json'), 'utf8'));
  assert.equal(settings.statusLine.refreshInterval, 30);
  assert.ok(!settings.statusLine.command.includes(srv.token), 'no token in the command');
  await type(v.id, 'statusline');
  const ctx = await until(async () => (await view(v.id)).context, 5000, 'context');
  assert.deepEqual(ctx.pct, 6);
  assert.equal(ctx.tokens, 59634 + 109);
  assert.equal(ctx.size, 1000000);
  const { expiresAt, ...cache } = ctx.cache;
  assert.deepEqual(cache, { warm: true, recacheTokens: 59634 });
  assert.ok(expiresAt > Date.now() + 50 * 60_000 && expiresAt <= Date.now() + 3600_000, `cache expiry an hour out, got ${expiresAt}`);
  const screen = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = request(`${srv.url}/api/sessions/${v.id}/snapshot`, { headers: { 'x-tend-token': srv.token } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(Buffer.from(b, 'base64').toString('utf8')));
      });
      r.on('error', reject);
      r.end();
    });
  await until(async () => (await screen()).includes('status line: USER-SL') || undefined, 5000, "the user's own status line output");
});

test('a status from a stale launch is ignored', async () => {
  const v = await mk('stale', { account: process.env.CLAUDE_CONFIG_DIR });
  const r = await call('POST', '/status', { context_window: { used_percentage: 77 } }, undefined, { 'x-tend-session': v.id, 'x-tend-launch': 'nope' });
  assert.equal(r.status, 200);
  assert.equal((await view(v.id)).context, undefined);
  await call('POST', '/status', { context_window: { used_percentage: 77 } }, undefined, { 'x-tend-session': v.id, 'x-tend-launch': launchOf(home, v.id) });
  assert.equal((await view(v.id)).context.pct, 77);
});

test('accounts: listed, chosen explicitly or by most headroom, and used at launch', async () => {
  const names = (await usage()).map((a) => a.name);
  assert.deepEqual(names.slice(1), ['work', 'spare']);
  assert.equal((await call('POST', '/api/sessions', { cwd: home, account: '/nope' })).status, 400);
  const a = await mk('on-work', { account: work });
  assert.equal(a.account, work);
  const envOf = (id: string) => JSON.parse(readFileSync(join(home, 'sessions', id, 'env.json'), 'utf8')).CLAUDE_CONFIG_DIR;
  await until(() => existsSync(join(home, 'sessions', a.id, 'env.json')) || undefined, 3000, 'env.json');
  assert.equal(envOf(a.id), work);
  // work and the default account report use; spare has none → new work goes to spare
  await type(a.id, 'status 20 40');
  const d = await mk('on-default', { account: process.env.CLAUDE_CONFIG_DIR });
  await type(d.id, 'status 20 30');
  await until(async () => (await usage()).find((x) => x.dir === work)?.fiveHour?.pct === 40 || undefined, 5000, 'work usage');
  await until(async () => (await usage()).find((x) => x.dir === process.env.CLAUDE_CONFIG_DIR)?.fiveHour?.pct === 30 || undefined, 5000, 'default usage');
  // "roomiest" picks among accounts that report (spare never did): default at 30% beats work at 40%
  assert.equal((await mk('auto', { account: 'roomiest' })).account, process.env.CLAUDE_CONFIG_DIR);
  // with no account: the one last used for this folder
  const again = await mk('again');
  assert.equal(again.account, process.env.CLAUDE_CONFIG_DIR);
  const w2 = await mk('work-again', { account: work });
  assert.equal(w2.account, work);
  assert.equal((await mk('follows')).account, work, 'follows the last choice for this folder');
  const u = (await usage()).find((x) => x.dir === work);
  assert.equal(u.fiveHour.zone, 'chill'); // 40% with 80% of the window gone: projected 50
  assert.match(u.fiveHour.projection, /stay under it/);
});

test('one notification when the 5-hour pace turns hot, and usage survives a restart', async () => {
  const v = await mk('heavy', { account: spare });
  await type(v.id, 'status 50 95');
  await until(async () => (await usage()).find((x) => x.dir === spare)?.fiveHour?.zone === 'hot' || undefined, 5000, 'hot');
  await type(v.id, 'status 51 96');
  await until(async () => (await usage()).find((x) => x.dir === spare)?.fiveHour?.pct === 96 || undefined, 5000, 'second update');
  const notes = readFileSync(join(home, 'notify.jsonl'), 'utf8').split('\n').filter((l) => l.includes('sustainable pace'));
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /spare: 5-hour use at 95%/);
  await srv.stop();
  srv = await startServer(env);
  const after = (await usage()).find((x) => x.dir === spare);
  assert.equal(after.fiveHour.pct, 96);
  assert.ok(after.at > 0);
  assert.equal((await view(v.id)).context.pct >= 50, true, 'context comes back after a restart');
});
