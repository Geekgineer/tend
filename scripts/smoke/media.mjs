#!/usr/bin/env node
// Real-claude smoke (v0.6): an image attached through Tend is read and described, with no permission prompt.
// One haiku session in a temp git repo (worktree). Always cleans up; exits non-zero on failure.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

const PORT = 4983;
const socket = `tend-smoke6-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), 'tend-smoke-home-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'tend-smoke-repo-')));
process.env.TEND_HOME = home;
process.env.TEND_CLAUDE_BIN = 'claude';
process.env.TEND_CLAUDE_ARGS = '--model haiku --permission-mode default';
process.env.TEND_ACCOUNTS = ':';
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const log = (/** @type {string} */ m) => process.stdout.write(`[smoke6] ${m}\n`);
/** A solid-colour PNG. @param {number} w @param {number} h @param {number[]} rgb */
function png(w, h, rgb) {
  const chunk = (/** @type {string} */ t, /** @type {Buffer} */ d) => {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
/** @type {{ close(): Promise<void> } | undefined} */
let srv;
let failure = '';
async function until(/** @type {() => any} */ fn, /** @type {number} */ ms, /** @type {string} */ what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
}
try {
  const [{ startServer }, { loadOrCreateToken }] = await Promise.all([import('../../src/server.ts'), import('../../src/config.ts')]);
  const token = loadOrCreateToken(home);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  srv = await startServer({ home, port: PORT, token, tmuxSocket: socket, notifyMode: 'off' });
  const api = (/** @type {string} */ p, /** @type {RequestInit} */ init = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...init, headers: { 'x-tend-token': token, ...(init.headers ?? {}) } });
  const keys = (/** @type {string} */ id, /** @type {string} */ s) => api(`/api/sessions/${id}/keys`, { method: 'POST', body: s });
  const view = async (/** @type {string} */ id) => (await (await api('/api/sessions')).json()).find((/** @type {{id:string}} */ v) => v.id === id);
  const screen = async (/** @type {string} */ id) => Buffer.from(await (await api(`/api/sessions/${id}/snapshot`)).text(), 'base64').toString('utf8');
  const db = new DatabaseSync(join(home, 'tend.sqlite'), { readOnly: true });
  const lastStop = (/** @type {string} */ id) => {
    const r = db.prepare("SELECT json FROM events WHERE session_id = ? AND kind = 'Stop' ORDER BY id DESC LIMIT 1").get(id);
    return r ? String(JSON.parse(String(r.json)).data?.last_assistant_message ?? '') : '';
  };
  // probe session accepts trust for the repo (a throwaway temp repo), then the real one runs in a worktree
  const probe = (await (await api('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: repo, name: 'probe' }) })).json()).id;
  await until(async () => (await screen(probe)).toLowerCase().includes('trust this folder'), 20_000, 'trust dialog');
  await sleep(1000);
  await keys(probe, '\x1b[B');
  await sleep(300);
  await keys(probe, '\r');
  await until(async () => (await view(probe))?.state?.status === 'idle', 20_000, 'probe idle');
  await api(`/api/sessions/${probe}/archive`, { method: 'POST' });
  const id = (await (await api('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: repo, name: 'smoke6' }) })).json()).id;
  await until(async () => (await view(id))?.state?.status === 'idle', 30_000, 'idle');
  await keys(id, 'What single colour fills this image? Reply with one word: ');
  const up = await api(`/api/sessions/${id}/attachments`, { method: 'POST', headers: { 'x-file-name': 'swatch.png' }, body: png(64, 64, [220, 30, 30]) });
  if (up.status !== 201) throw new Error(`upload -> ${up.status} ${await up.text()}`);
  const a = await up.json();
  log(`attached ${a.name}; pasted ${a.insert.trim()}`);
  await sleep(800);
  await keys(id, '\r');
  const reply = await until(() => lastStop(id), 90_000, 'a reply');
  const v = await view(id);
  log(`Claude: ${JSON.stringify(reply.trim())}; decisions while reading: ${v.decisions?.length ?? 0}`);
  if (!/red/i.test(reply)) throw new Error('the image was not described as red');
  if (v.decisions?.length) throw new Error('reading the attachment asked for permission');
  log('PASS');
  db.close();
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[smoke6] FAIL: ${failure}\n`);
} finally {
  try {
    execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // none
  }
  try {
    await srv?.close();
  } catch {
    // closed
  }
  rmSync(join('/private/tmp', `tmux-${userInfo().uid}`, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
process.exit(failure ? 1 : 0);
