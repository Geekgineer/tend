#!/usr/bin/env node
// Probe: the Elsewhere section in a real browser. Fake claude, temp folders. One tend session, one session "open
// elsewhere" and one closed there with a saved conversation; Adopt must select the new tend session.
// Screenshots (light and dark) go to $PROBE_OUT when set.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../lib/cdp.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'tend-else-')));
const socket = `tend-else-${process.pid}`;
const config = mkdtempSync(join(tmpdir(), 'tend-else-claude-'));
process.env.TEND_CLAUDE_BIN = join(ROOT, 'test', 'fake-claude.mjs');
process.env.CLAUDE_CONFIG_DIR = config;
process.env.TEND_ACCOUNTS = ':';
const out = process.env.PROBE_OUT;
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {{ port: number }} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});
const { startServer } = await import('../../src/server.ts');
const token = 'el-' + Math.random().toString(36).slice(2);
const srv = await startServer({ home, port, token, tmuxSocket: socket, notifyMode: 'stub' });
const base = `http://127.0.0.1:${port}`;
const dirs = Object.fromEntries(['api', 'web-app', 'docs-site'].map((n) => [n, join(home, n)]));
for (const d of Object.values(dirs)) mkdirSync(d);
await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'x-tend-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ cwd: dirs.api, name: 'api', isolate: false }) });

const OPEN = '0a0a0a0a-1111-4222-8333-444444444444';
const CLOSED = '0b0b0b0b-1111-4222-8333-444444444444';
const now = Date.now();
const gonePid = spawnSync('true').pid; // a process that has exited, like a closed claude
const row = (/** @type {string} */ sessionId, /** @type {string} */ cwd, /** @type {string} */ name, /** @type {string} */ status) => ({ pid: sessionId === CLOSED ? gonePid : process.pid, cwd, kind: 'interactive', startedAt: now, sessionId, name, status });
writeFileSync(join(config, 'agents.json'), JSON.stringify([row(OPEN, dirs['web-app'], 'web-app-12', 'busy'), row(CLOSED, dirs['docs-site'], 'docs rewrite', 'idle')]));
mkdirSync(join(config, 'projects', '-docs'), { recursive: true });
writeFileSync(join(config, 'projects', '-docs', `${CLOSED}.jsonl`), '{}\n');

const browser = await openBrowser();
const page = await browser.page();
const fails = [];
const shot = async (/** @type {string} */ name) => {
  if (!out) return;
  const { data } = await page.s('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'));
};
try {
  await page.s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${base}/?key=${token}&tab=all&theme=dark`);
  await page.until(`return document.querySelectorAll('.elsewhere [data-ext]').length === 2`, 'two rows elsewhere', 15_000);
  // the closed one: its process went away (listing no longer has it) — tend marks it closed on the next look
  writeFileSync(join(config, 'agents.json'), JSON.stringify([row(OPEN, dirs['web-app'], 'web-app-12', 'busy')]));
  // the next poll is 10 s; force one now by switching tabs
  await sleep(4200);
  await page.click('#seg button', 'For you');
  await page.click('#seg button', 'All sessions');
  await page.until(`return document.querySelector('.elsewhere [data-adopt]') !== null`, 'an Adopt button', 15_000);
  const live = await page.js(`return document.querySelector('.elsewhere [data-ext="${OPEN}"] .xh')?.textContent ?? ''`);
  if (!/open elsewhere/.test(live)) fails.push(`the open session should offer no Adopt, got "${live}"`);
  await shot('elsewhere-dark');
  await page.navigate(`${base}/?key=${token}&tab=all&theme=light`);
  await page.until(`return document.querySelector('.elsewhere [data-adopt]') !== null`, 'Adopt after reload', 15_000);
  await shot('elsewhere-light');
  await page.click('.elsewhere [data-adopt]');
  await page.until(`return [...document.querySelectorAll('#list .row.on[data-id]')].some((r) => r.textContent.includes('docs rewrite'))`, 'the adopted session selected', 15_000);
  const gone = await page.js(`return document.querySelector('.elsewhere [data-ext="${CLOSED}"]') === null`);
  if (!gone) fails.push('the adopted session is still listed elsewhere');
  await sleep(800);
  await shot('elsewhere-adopted');
} catch (e) {
  fails.push(String(e));
}
if (page.errors.length) fails.push(`page errors: ${page.errors.join(' | ')}`);
console.log(fails.length ? `FAIL\n${fails.join('\n')}` : 'ok: listed, open one not adoptable, closed one adopted and selected, no page errors');
browser.close();
await srv.close();
try {
  execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
} catch {}
rmSync(home, { recursive: true, force: true });
rmSync(config, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
