#!/usr/bin/env node
// Real-claude smoke (v0.4): a real session's status line reaches Tend, and Tend's context % / tokens / usage windows
// equal the JSON Claude passed. The temp repo's own statusLine (project local) tees that JSON to a file, which also
// proves the wrapper still runs the user's status line. One haiku session, one tiny prompt.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const PORT = 4982;
const socket = `tend-smoke4-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), 'tend-smoke-home-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'tend-smoke-repo-')));
const seen = join(home, 'claude-said.json');
process.env.TEND_HOME = home;
process.env.TEND_CLAUDE_BIN = 'claude';
process.env.TEND_CLAUDE_ARGS = '--model haiku';
process.env.TEND_ACCOUNTS = ':';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const log = (/** @type {string} */ m) => process.stdout.write(`[smoke4] ${m}\n`);
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
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: `tee ${JSON.stringify(seen)} >/dev/null; echo PROJECT-SL` } }));
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  srv = await startServer({ home, port: PORT, token, tmuxSocket: socket, notifyMode: 'off' });
  const api = (/** @type {string} */ p, /** @type {RequestInit} */ init = {}) =>
    fetch(`http://127.0.0.1:${PORT}${p}`, { ...init, headers: { 'x-tend-token': token, 'content-type': 'application/json' } });
  const keys = (/** @type {string} */ id, /** @type {string} */ s) => api(`/api/sessions/${id}/keys`, { method: 'POST', body: s });
  const view = async (/** @type {string} */ id) => (await (await api('/api/sessions')).json()).find((/** @type {{id:string}} */ v) => v.id === id);
  const screen = async (/** @type {string} */ id) => Buffer.from(await (await api(`/api/sessions/${id}/snapshot`)).text(), 'base64').toString('utf8');

  const id = (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd: repo, name: 'smoke4', isolate: false }) })).json()).id;
  await until(async () => (await screen(id)).toLowerCase().includes('trust this folder'), 20_000, 'trust dialog');
  await sleep(1000);
  await keys(id, '\x1b[B');
  await sleep(300);
  await keys(id, '\r');
  await until(async () => (await view(id))?.state?.status === 'idle', 20_000, 'idle');
  await keys(id, 'Reply with only OK.');
  await sleep(500);
  await keys(id, '\r');
  // after the turn the status line reports a real context %
  const v = await until(async () => {
    const x = await view(id);
    return x?.context?.pct != null && existsSync(seen) ? x : undefined;
  }, 90_000, 'a context % from the status line');
  await sleep(2500); // let one more update land on both sides
  const said = JSON.parse(readFileSync(seen, 'utf8'));
  const got = (await view(id)).context;
  const want = { pct: said.context_window.used_percentage, tokens: said.context_window.total_input_tokens + said.context_window.total_output_tokens, size: said.context_window.context_window_size };
  log(`Claude said: ${JSON.stringify(want)}; Tend shows: ${JSON.stringify({ pct: got.pct, tokens: got.tokens, size: got.size })}`);
  if (got.pct !== want.pct || got.size !== want.size || got.tokens !== want.tokens) throw new Error('context differs from what Claude passed');
  const acct = (await (await api('/api/usage')).json()).accounts[0];
  const rl = said.rate_limits;
  if (rl?.five_hour) {
    log(`5-hour: Claude ${rl.five_hour.used_percentage}% resets ${rl.five_hour.resets_at}; Tend ${acct.fiveHour?.pct}% resets ${acct.fiveHour ? acct.fiveHour.resetsAt / 1000 : null} (${acct.fiveHour?.zone})`);
    if (acct.fiveHour?.pct !== rl.five_hour.used_percentage || acct.fiveHour.resetsAt !== rl.five_hour.resets_at * 1000) throw new Error('5-hour usage differs');
  } else log('no rate_limits in the status JSON (not a subscriber plan?)');
  if (rl?.seven_day) {
    log(`week: Claude ${rl.seven_day.used_percentage}%; Tend ${acct.sevenDay?.pct}%`);
    if (acct.sevenDay?.pct !== rl.seven_day.used_percentage) throw new Error('weekly usage differs');
  }
  if (!(await screen(id)).includes('PROJECT-SL')) throw new Error("the project's own status line output is not on screen");
  log("the project's own status line still shows (PROJECT-SL)");
  log(`model ${got.model}; cache ${JSON.stringify(got.cache)}; sample view state ${v.state.status}`);
  log('PASS');
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[smoke4] FAIL: ${failure}\n`);
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
