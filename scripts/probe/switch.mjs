#!/usr/bin/env node
// Probe: switching sessions fast must throw no page errors (xterm disposed mid-repaint). Fake claude, temp folders.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../lib/cdp.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'tend-switch-')));
const socket = `tend-switch-${process.pid}`;
process.env.TEND_CLAUDE_BIN = join(ROOT, 'test', 'fake-claude.mjs');
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tend-switch-claude-'));
process.env.TEND_ACCOUNTS = ':';
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {{ port: number }} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});
const { startServer } = await import('../../src/server.ts');
const token = 'sw-' + Math.random().toString(36).slice(2);
const srv = await startServer({ home, port, token, tmuxSocket: socket, notifyMode: 'stub' });
const base = `http://127.0.0.1:${port}`;
const ids = [];
for (const n of ['a', 'b', 'c']) {
  const dir = join(home, n);
  mkdirSync(dir);
  const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'x-tend-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ cwd: dir, name: n, isolate: false }) });
  ids.push((await r.json()).id);
}
await sleep(2000);
const browser = await openBrowser();
const page = await browser.page();
await page.navigate(`${base}/?key=${token}&tab=all`);
await page.until(`return document.querySelectorAll('#list [data-id]').length === 3`, 'list', 15_000);
for (let i = 0; i < 60; i++) {
  const id = ids[i % ids.length];
  await page.js(`document.querySelector('#list [data-id="${id}"]')?.click(); return true;`);
  await sleep(i % 3 === 0 ? 0 : 30);
  if (i % 7 === 0) await page.js(`document.querySelectorAll('.dtabs button')[1]?.click(); return true;`);
  if (i % 7 === 3) await page.js(`document.querySelectorAll('.dtabs button')[0]?.click(); return true;`);
}
await sleep(1500);
console.log(`page errors after 60 fast switches: ${page.errors.length}${page.errors.length ? `\n${page.errors[0]}` : ''}`);
browser.close();
await srv.close();
try {
  execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
} catch {}
rmSync(home, { recursive: true, force: true });
process.exit(page.errors.length ? 1 : 0);
