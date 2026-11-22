#!/usr/bin/env node
// Real-claude smoke (v0.2): trust as needs-you, a worktree session, pause, resume with memory. One short session (--model haiku) in a temp git repo. Always cleans up; exits non-zero on failure.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const PORT = 4978;
const socket = `tend-smoke-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), 'tend-smoke-home-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'tend-smoke-repo-')));

process.env.TEND_HOME = home;
process.env.TEND_PORT = String(PORT);
process.env.TEND_TMUX_SOCKET = socket;
process.env.TEND_CLAUDE_BIN = 'claude';
process.env.TEND_CLAUDE_ARGS = '--model haiku';
process.env.TEND_NOTIFY = 'off';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const log = (/** @type {string} */ m) => process.stdout.write(`[smoke] ${m}\n`);

/** @type {{ close(): Promise<void> } | undefined} */
let srv;
let failure = '';

async function until(/** @type {() => Promise<boolean>|boolean} */ fn, /** @type {number} */ ms, /** @type {string} */ what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
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
  const base = `http://127.0.0.1:${PORT}`;
  const api = (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) =>
    fetch(base + path, { ...init, headers: { 'x-tend-token': token, ...(init.headers ?? {}) } });
  const screen = async (/** @type {string} */ id) => {
    const r = await api(`/api/sessions/${id}/snapshot`);
    return r.ok ? Buffer.from(await r.text(), 'base64').toString('utf8') : '';
  };
  const keys = (/** @type {string} */ id, /** @type {string} */ s) => api(`/api/sessions/${id}/keys`, { method: 'POST', body: s });

  /** @param {string} id */
  const view = async (id) => (await (await api('/api/sessions')).json()).find((/** @type {{id:string}} */ v) => v.id === id);
  const db = new DatabaseSync(join(home, 'tend.sqlite'), { readOnly: true });
  /** Stop events for a session after a given event row id. @param {string} id @param {number} after */
  const stops = (id, after) =>
    db.prepare("SELECT id, json FROM events WHERE session_id = ? AND kind = 'Stop' AND id > ? ORDER BY id").all(id, after)
      .map((r) => ({ row: Number(r.id), msg: String(JSON.parse(String(r.json)).data?.last_assistant_message ?? '') }));
  const lastRow = () => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').get()?.m ?? 0);
  /** Accept the trust dialog if (or once) it is shown. @param {string} id @param {boolean} required */
  const acceptTrust = async (id, required) => {
    const shown = async () => (await screen(id)).toLowerCase().includes('trust this folder');
    if (required) await until(shown, 20_000, 'trust dialog');
    else {
      await sleep(4000);
      if (!(await shown())) return;
    }
    if (required) {
      await until(async () => (await view(id))?.state?.need === 'trust', 10_000, 'needs_you/trust state');
      log('trust dialog surfaced as needs_you/trust');
    }
    await sleep(1000); // let the dialog become interactive before the first key
    await keys(id, '\x1b[B');
    await sleep(300);
    await keys(id, '\r');
    await until(async () => !(await shown()), 10_000, 'trust dialog to go away');
    log('trust dialog accepted');
    await sleep(2000);
  };
  /** @param {string} id @param {string} text */
  const prompt = async (id, text) => {
    await keys(id, text);
    await sleep(500);
    await keys(id, '\r');
  };

  // Claude records trust per git repo: the first worktree session of a repo asks, later ones don't
  const firstRes = await api('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: repo, name: 'trust-probe' }) });
  if (firstRes.status !== 201) throw new Error(`create probe session -> ${firstRes.status}`);
  const probe = (await firstRes.json()).id;
  log(`probe session ${probe} created`);
  await acceptTrust(probe, true);
  const killProbe = await api(`/api/sessions/${probe}/archive`, { method: 'POST' });
  if (killProbe.status !== 204) throw new Error(`archive probe -> ${killProbe.status}`);
  log('probe archived; repo is now trusted');

  const created = await api('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: repo, name: 'smoke' }) });
  if (created.status !== 201) throw new Error(`create session -> ${created.status}`);
  const first = await created.json();
  const id = first.id;
  if (first.workspace?.mode !== 'worktree') throw new Error(`expected a worktree session, got ${JSON.stringify(first.workspace)}`);
  log(`session ${id} created on ${first.workspace.branch}`);

  await sleep(6000);
  if ((await screen(id)).toLowerCase().includes('trust this folder')) throw new Error('a second worktree session of a trusted repo still shows the trust dialog');
  log('second worktree session of the repo started with no trust dialog');
  let mark = lastRow();
  await prompt(id, 'Remember the word PELICAN. Reply only OK.');
  log('prompt 1 sent');
  await until(() => stops(id, mark).length > 0, 90_000, 'Stop after prompt 1');
  log(`turn 1 done: ${JSON.stringify(stops(id, mark)[0]?.msg)}`);

  const paused = await api(`/api/sessions/${id}/pause`, { method: 'POST' });
  if (paused.status !== 200) throw new Error(`pause -> ${paused.status} ${await paused.text()}`);
  if (!(await paused.json()).paused) throw new Error('pause did not mark the session paused');
  log('paused');
  const resumed = await api(`/api/sessions/${id}/resume`, { method: 'POST' });
  if (resumed.status !== 200) throw new Error(`resume -> ${resumed.status} ${await resumed.text()}`);
  log('resumed');
  await acceptTrust(id, false);
  await until(async () => (await screen(id)).includes('\u276f') || (await screen(id)).includes('>'), 30_000, 'prompt after resume');
  await sleep(2000);
  mark = lastRow();
  await prompt(id, 'What word did I ask you to remember? Reply with the word only.');
  log('prompt 2 sent');
  await until(() => stops(id, mark).some((s) => /PELICAN/i.test(s.msg)), 90_000, 'a Stop mentioning PELICAN after resume').catch(async (e) => {
    log(`stops after resume: ${JSON.stringify(stops(id, mark))}`);
    log(`screen:\n${(await screen(id)).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')}`);
    throw e;
  });
  log('resumed conversation remembered PELICAN');
  db.close();
  log('PASS');
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[smoke] FAIL: ${failure}\n`);
} finally {
  try {
    execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // no tmux server running
  }
  try {
    await srv?.close();
  } catch {
    // already closed
  }
  rmSync(join('/private/tmp', `tmux-${userInfo().uid}`, socket), { force: true }); // stale socket file
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
process.exit(failure ? 1 : 0);
