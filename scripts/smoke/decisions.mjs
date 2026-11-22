#!/usr/bin/env node
// Real-claude smoke (v0.3): permissions, a question and a plan answered from Tend's cards, and a request
// answered in the terminal. One short haiku session in a temp git repo, --permission-mode default so Claude
// asks. Always cleans up; exits non-zero on failure.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const PORT = 4979;
const socket = `tend-smoke3-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), 'tend-smoke-home-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'tend-smoke-repo-')));

process.env.TEND_HOME = home;
process.env.TEND_CLAUDE_BIN = 'claude';
process.env.TEND_CLAUDE_ARGS = '--model haiku --permission-mode default';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const log = (/** @type {string} */ m) => process.stdout.write(`[smoke3] ${m}\n`);
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** @type {{ close(): Promise<void> } | undefined} */
let srv;
let failure = '';

async function until(/** @type {() => Promise<any>|any} */ fn, /** @type {number} */ ms, /** @type {string} */ what) {
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
  const base = `http://127.0.0.1:${PORT}`;
  const api = (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) =>
    fetch(base + path, { ...init, headers: { 'x-tend-token': token, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const screen = async (/** @type {string} */ id) => {
    const r = await api(`/api/sessions/${id}/snapshot`);
    return r.ok ? plain(Buffer.from(await r.text(), 'base64').toString('utf8')) : '';
  };
  const keys = (/** @type {string} */ id, /** @type {string} */ s) => api(`/api/sessions/${id}/keys`, { method: 'POST', body: s });
  const view = async (/** @type {string} */ id) => (await (await api('/api/sessions')).json()).find((/** @type {{id:string}} */ v) => v.id === id);
  const decide = async (/** @type {string} */ id, /** @type {string} */ did, /** @type {unknown} */ body) => {
    const r = await api(`/api/sessions/${id}/decisions/${did}`, { method: 'POST', body: JSON.stringify(body) });
    if (r.status !== 200) throw new Error(`answer ${JSON.stringify(body)} -> ${r.status} ${await r.text()}`);
  };
  const db = new DatabaseSync(join(home, 'tend.sqlite'), { readOnly: true });
  const lastRow = () => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').get()?.m ?? 0);
  const stopAfter = (/** @type {string} */ id, /** @type {number} */ after) => {
    const r = db.prepare("SELECT json FROM events WHERE session_id = ? AND kind = 'Stop' AND id > ? ORDER BY id DESC LIMIT 1").get(id, after);
    return r ? String(JSON.parse(String(r.json)).data?.last_assistant_message ?? '') || ' ' : '';
  };
  const prompt = async (/** @type {string} */ id, /** @type {string} */ text) => {
    await keys(id, text);
    await sleep(500);
    await keys(id, '\r');
  };
  const decision = (/** @type {string} */ id, /** @type {string} */ kind) =>
    until(async () => (await view(id))?.decisions?.find((/** @type {{kind:string}} */ d) => d.kind === kind), 90_000, `a ${kind} card`).catch(async (e) => {
      log(`screen:\n${await screen(id)}`);
      throw e;
    });

  const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd: repo, name: 'smoke3', isolate: false }) });
  if (res.status !== 201) throw new Error(`create -> ${res.status}`);
  const id = (await res.json()).id;
  log(`session ${id} created in place`);
  // a throwaway temp repo: accept Claude's trust dialog for it (Tend itself never does)
  await until(async () => (await screen(id)).toLowerCase().includes('trust this folder'), 20_000, 'trust dialog');
  await sleep(1000);
  await keys(id, '\x1b[B');
  await sleep(300);
  await keys(id, '\r');
  await until(async () => (await view(id))?.state?.status === 'idle', 20_000, 'idle after trust');
  log('trusted; idle');

  // 1. allow from a card runs the tool
  let mark = lastRow();
  await prompt(id, 'Run this exact shell command and nothing else: mkdir tend-allowed');
  let d = await decision(id, 'permission');
  log(`permission card: ${d.tool} ${JSON.stringify(d.command)} risk=${d.risk.level}`);
  await decide(id, d.id, { action: 'allow' });
  await until(() => stopAfter(id, mark), 90_000, 'Stop after allow');
  await until(() => existsSync(join(repo, 'tend-allowed')), 10_000, 'the folder tend-allowed');
  log('allowed from Tend: the command ran');

  // 2. deny from a card stops it
  mark = lastRow();
  await prompt(id, 'Create a file named denied.txt containing the letter x. If you are not allowed, reply only DENIED.');
  d = await decision(id, 'permission');
  log(`permission card: ${d.tool} ${d.filePath ?? d.command} risk=${d.risk.level} (${d.risk.rule})`);
  await decide(id, d.id, { action: 'deny', message: 'Not this time.' });
  await until(() => stopAfter(id, mark), 90_000, 'Stop after deny');
  if (existsSync(join(repo, 'denied.txt'))) throw new Error('denied.txt exists after a deny');
  log('denied from Tend: no file written');

  // 3. a question answered from a card
  mark = lastRow();
  await prompt(id, 'Use the AskUserQuestion tool to ask me "Which colour?" with exactly two options, Red and Blue. Then reply with only the colour I picked.');
  d = await decision(id, 'question');
  const q = d.questions[0];
  log(`question card: ${JSON.stringify(q.question)} options=${q.options.map((/** @type {{label:string}} */ o) => o.label).join('/')}`);
  const blue = q.options.find((/** @type {{label:string}} */ o) => /blue/i.test(o.label)) ?? q.options[q.options.length - 1];
  await decide(id, d.id, { action: 'answers', answers: { [q.question]: blue.label } });
  const reply = await until(() => stopAfter(id, mark), 90_000, 'Stop after the answer');
  if (!new RegExp(blue.label, 'i').test(reply)) throw new Error(`answer not used: ${JSON.stringify(reply)}`);
  log(`question answered from Tend: Claude replied ${JSON.stringify(reply.trim())}`);

  // 4. a request answered in the terminal resolves the card
  mark = lastRow();
  await prompt(id, 'Run this exact shell command and nothing else: mkdir tend-terminal');
  d = await decision(id, 'permission');
  await sleep(1500);
  await keys(id, '\r'); // Claude's own dialog: Enter picks "Yes"
  await until(async () => !(await view(id))?.decisions, 20_000, 'card resolved after the terminal answer').catch(async (e) => {
    log(`dir made: ${existsSync(join(repo, 'tend-terminal'))}; state: ${JSON.stringify((await view(id))?.state)}`);
    log(`screen:\n${await screen(id)}`);
    throw e;
  });
  const late = await api(`/api/sessions/${id}/decisions/${d.id}`, { method: 'POST', body: JSON.stringify({ action: 'deny' }) });
  if (late.status !== 409) throw new Error(`late card answer -> ${late.status}`);
  await until(() => stopAfter(id, mark), 90_000, 'Stop after the terminal answer');
  log('answered in the terminal: card resolved, late card answer was 409');

  // 5. a plan approved from a card starts implementing
  await keys(id, '\x1b[Z'); // Shift+Tab: default -> accept edits
  await sleep(500);
  await keys(id, '\x1b[Z'); // -> plan mode
  await until(async () => /plan mode/i.test(await screen(id)), 10_000, 'plan mode');
  mark = lastRow();
  await prompt(id, 'Plan: create a file plan.txt containing ok. Keep the plan to one step and present it with ExitPlanMode.');
  d = await decision(id, 'plan');
  log(`plan card: ${JSON.stringify(d.plan.slice(0, 80))}`);
  await decide(id, d.id, { action: 'approve' });
  // after approval Claude implements; in manual mode the Write asks again
  const w = await until(async () => (await view(id))?.decisions?.find((/** @type {{kind:string}} */ x) => x.kind === 'permission') ?? (existsSync(join(repo, 'plan.txt')) ? { done: true } : undefined), 90_000, 'the Write after the plan');
  if (!w.done) await decide(id, w.id, { action: 'allow' });
  await until(() => existsSync(join(repo, 'plan.txt')), 60_000, 'plan.txt');
  log(`plan approved from Tend: plan.txt = ${JSON.stringify(readFileSync(join(repo, 'plan.txt'), 'utf8').trim())}`);
  db.close();
  log('PASS');
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[smoke3] FAIL: ${failure}\n`);
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
  rmSync(join('/private/tmp', `tmux-${userInfo().uid}`, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
process.exit(failure ? 1 : 0);
