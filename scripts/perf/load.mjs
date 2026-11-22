#!/usr/bin/env node
// Load (spec §18 scenario 7, compressed): 20 sessions (fake claude) under a steady hook and status-line stream for
// LOAD_SECONDS (default 120). Measures API and keystroke round-trip latency and memory; checks no event is lost.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SECONDS = Number(process.env.LOAD_SECONDS ?? 120);
const SESSIONS = 20;
const root = join(import.meta.dirname, '..', '..');
const home = mkdtempSync(join(tmpdir(), 'tend-load-'));
const socket = `tend-load-${process.pid}`;
process.env.TEND_CLAUDE_BIN = join(root, 'test', 'fake-claude.mjs');
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tend-load-claude-'));
process.env.TEND_ACCOUNTS = ':';
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {{ port: number }} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});
const pct = (/** @type {number[]} */ xs, /** @type {number} */ p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};
const { startServer } = await import('../../src/server.ts');
const { loadOrCreateToken } = await import('../../src/config.ts');
const port = /** @type {number} */ (await freePort());
const token = loadOrCreateToken(home);
const srv = await startServer({ home, port, token, tmuxSocket: socket, notifyMode: 'off', watchIntervalMs: 2000 });
const base = `http://127.0.0.1:${port}`;
const h = { 'x-tend-token': token };
let failure = '';
try {
  const ids = [];
  for (let i = 0; i < SESSIONS; i++) {
    const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ cwd: home, name: `load-${i}`, isolate: false }) });
    ids.push((await r.json()).id);
  }
  await new Promise((r) => setTimeout(r, 2000));
  const hookToken = readFileSync(join(home, 'hook-token'), 'utf8').trim();
  const launch = (/** @type {string} */ id) => JSON.parse(readFileSync(join(home, 'sessions', id, 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0].headers['x-tend-launch'];
  const launches = Object.fromEntries(ids.map((id) => [id, launch(id)]));
  const sent = Object.fromEntries(ids.map((id) => [id, 0]));
  const api = [];
  const keys = [];
  const rss = [];
  const end = Date.now() + SECONDS * 1000;
  const kinds = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];
  let n = 0;
  while (Date.now() < end) {
    // each tick: every session sends a hook and a status update (≈ 10 events/s per session at 100 ms ticks)
    await Promise.all(ids.map(async (id) => {
      const kind = kinds[n % kinds.length];
      await fetch(`${base}/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tend-token': hookToken, 'x-tend-session': id, 'x-tend-launch': launches[id] }, body: JSON.stringify({ hook_event_name: kind, tool_name: 'Bash', tool_input: { command: 'ls' }, last_assistant_message: 'ok' }) });
      sent[id]++;
      await fetch(`${base}/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tend-token': hookToken, 'x-tend-session': id, 'x-tend-launch': launches[id] }, body: JSON.stringify({ context_window: { used_percentage: n % 100, total_input_tokens: n * 1000 } }) });
    }));
    if (n % 10 === 0) {
      let t = performance.now();
      await (await fetch(`${base}/api/sessions`, { headers: h })).json();
      api.push(performance.now() - t);
      t = performance.now();
      await fetch(`${base}/api/sessions/${ids[n % SESSIONS]}/keys`, { method: 'POST', headers: h, body: 'x' });
      keys.push(performance.now() - t);
      rss.push(process.memoryUsage().rss / 1e6);
    }
    n++;
    await new Promise((r) => setTimeout(r, 100));
  }
  // every hook must be in the store
  const db = new DatabaseSync(join(home, 'tend.sqlite'), { readOnly: true });
  let lost = 0;
  for (const id of ids) {
    const stored = Number(db.prepare("SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND kind IN ('PreToolUse','PostToolUse','UserPromptSubmit','Stop')").get(id)?.c ?? 0);
    if (stored < sent[id]) lost += sent[id] - stored;
  }
  db.close();
  const total = Object.values(sent).reduce((a, b) => a + b, 0);
  const report = {
    seconds: SECONDS, sessions: SESSIONS, hooks: total, lost,
    apiMs: { p50: +pct(api, 50).toFixed(1), p95: +pct(api, 95).toFixed(1), max: +Math.max(...api).toFixed(1) },
    keysMs: { p50: +pct(keys, 50).toFixed(1), p95: +pct(keys, 95).toFixed(1), max: +Math.max(...keys).toFixed(1) },
    rssMB: { start: +rss[0].toFixed(0), end: +rss[rss.length - 1].toFixed(0), max: +Math.max(...rss).toFixed(0) },
  };
  process.stdout.write(JSON.stringify(report) + '\n');
  if (lost > 0) failure = `${lost} hook events lost`;
  else if (report.keysMs.p95 > 100) failure = `keystroke round trip p95 ${report.keysMs.p95} ms (> 100 ms)`;
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
} finally {
  await srv.close();
  try {
    execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // none
  }
  rmSync(join('/private/tmp', `tmux-${userInfo().uid}`, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
}
if (failure) process.stderr.write(`[load] FAIL: ${failure}\n`);
else process.stdout.write('[load] PASS\n');
process.exit(failure ? 1 : 0);
