#!/usr/bin/env node
// Real Claude (haiku, a tiny prompt): a session started OUTSIDE tend, in a throwaway temp folder, shows up in
// Elsewhere; Adopt is refused while it's open; after /exit it's adopted and resumes the same conversation in tend
// (it still knows the word from before), with hooks driving tend's state. Never touches the user's own sessions.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'tend-adopt-home-')));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tend-adopt-proj-')));
const outside = `tend-adopt-out-${process.pid}`;
const socket = `tend-adopt-${process.pid}`;
const WORD = `PELICAN${Math.floor(Math.random() * 900 + 100)}`;
delete process.env.CLAUDE_CONFIG_DIR; // the real default account, as the user's own claude runs
process.env.TEND_ACCOUNTS = ':';
process.env.TEND_CLAUDE_ARGS = '--model haiku';
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (/** @type {string[]} */ ...a) => execFileSync('tmux', ['-L', outside, ...a], { encoding: 'utf8' });
const screen = () => tmux('capture-pane', '-p', '-t', 'out');
const steps = [];
const log = (/** @type {string} */ s) => {
  steps.push(s);
  console.log(`· ${s}`);
};
async function until(/** @type {() => Promise<unknown> | unknown} */ fn, /** @type {string} */ what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}

const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {{ port: number }} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});
const { startServer } = await import('../../src/server.ts');
const token = 'ad-' + Math.random().toString(36).slice(2);
const srv = await startServer({ home, port, token, tmuxSocket: socket, notifyMode: 'stub' });
const base = `http://127.0.0.1:${port}`;
/** @param {string} m @param {string} p @param {unknown} [body] @returns {Promise<{ status: number, body: any, text: string }>} */
const api = async (m, p, body) => {
  const r = await fetch(base + p, { method: m, headers: { 'x-tend-token': token, 'content-type': 'application/json' }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  const t = await r.text();
  let j = null;
  try {
    j = JSON.parse(t);
  } catch {}
  return { status: r.status, body: j, text: t };
};
/** @returns {Promise<any>} */
const ours = async () => (await api('GET', '/api/external')).body?.find((/** @type {any} */ r) => r.cwd === dir);

let ok = false;
try {
  // 1. the user's own way: claude in a terminal, outside tend
  tmux('new-session', '-d', '-s', 'out', '-x', '140', '-y', '40', '-c', dir, 'env', '-u', 'CLAUDE_CONFIG_DIR', 'claude', '--model', 'haiku');
  await until(() => /trust this folder|❯|>/i.test(screen()), 'claude started outside');
  await sleep(1500);
  if (/trust this folder/i.test(screen())) {
    // throwaway temp folder, test harness only (tend itself never accepts this)
    tmux('send-keys', '-t', 'out', 'Down');
    await sleep(300);
    tmux('send-keys', '-t', 'out', 'Enter');
    log('trust accepted for the temp folder (harness only)');
  }
  await until(() => /❯/.test(screen()) && !/trust this folder/i.test(screen()), 'the prompt box', 60_000);
  await sleep(3000);
  tmux('send-keys', '-t', 'out', '-l', `Remember this word: ${WORD}. Reply with just: noted`);
  await sleep(600);
  tmux('send-keys', '-t', 'out', 'Enter');
  // Claude's own reply line (⏺), not the text we typed
  await until(() => {
    if (/⏺\s*[Nn]oted/.test(screen())) return true;
    if (screen().includes('Reply with just: noted') && !/⏺/.test(screen())) tmux('send-keys', '-t', 'out', 'Enter'); // still in the box
    return false;
  }, 'first turn answered outside', 120_000);
  log('turn 1 answered in the outside terminal');

  // 2. tend lists it, read-only, and refuses Adopt while it's open
  const r = /** @type {any} */ (await until(ours, 'listed in Elsewhere', 30_000));
  if (!r.live) throw new Error('expected it live');
  log(`listed elsewhere: ${r.name} (${r.status})`);
  const refused = await api('POST', '/api/external/adopt', { sessionId: r.sessionId });
  if (refused.status !== 409) throw new Error(`adopt while open should be 409, got ${refused.status} ${refused.text}`);
  log(`adopt while open refused: ${refused.body.error}`);

  // 3. the user closes it there; tend sees it closed
  tmux('send-keys', '-t', 'out', '-l', '/exit');
  await sleep(400);
  tmux('send-keys', '-t', 'out', 'Enter');
  await until(async () => {
    await sleep(4500); // past the listing cache
    const x = await ours();
    return x && !x.live;
  }, 'shown as closed', 60_000);
  log('closed outside; shown as adoptable');

  // 4. adopt: same conversation, now under tend
  const a = await api('POST', '/api/external/adopt', { sessionId: r.sessionId });
  if (a.status !== 201) throw new Error(`adopt failed: ${a.status} ${a.text}`);
  const id = a.body.id;
  log(`adopted as tend session ${id} (${a.body.workspace.mode})`);
  const view = async () => (await api('GET', '/api/sessions')).body.find((/** @type {any} */ v) => v.id === id);
  const tscreen = async () => Buffer.from((await api('GET', `/api/sessions/${id}/snapshot`)).text, 'base64').toString('utf8');
  await until(async () => (await view())?.state.status === 'idle' || /❯/.test(await tscreen()), 'adopted claude ready', 60_000);
  await sleep(2000);
  await api('POST', `/api/sessions/${id}/keys`, `\x1b[200~What word did I ask you to remember? Reply with the word only.\x1b[201~`);
  await sleep(400);
  await api('POST', `/api/sessions/${id}/keys`, '\r');
  await until(async () => (await view())?.state.status === 'working', 'hooks: working', 30_000);
  log('hooks drive tend: working');
  await until(async () => (await view())?.state.status === 'idle', 'hooks: idle', 90_000);
  const scr = await tscreen();
  const after = scr.split('What word did I ask').pop() ?? '';
  if (!after.includes(WORD)) throw new Error(`the adopted session forgot the word; screen tail:\n${after.slice(-600)}`);
  log(`resumed conversation remembers ${WORD}`);
  if ((await ours()) !== undefined) throw new Error('still listed elsewhere after adopting');
  ok = true;
} catch (e) {
  console.log(`FAIL: ${e instanceof Error ? e.message : e}`);
  try {
    console.log(screen().slice(-1200));
  } catch {}
} finally {
  try {
    execFileSync('tmux', ['-L', outside, 'kill-server'], { stdio: 'ignore' });
  } catch {}
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {}
  await srv.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}
console.log(ok ? `ok: ${steps.length} steps` : 'FAILED');
process.exit(ok ? 0 : 1);
