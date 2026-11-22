#!/usr/bin/env node
// Probe: a folder window that never answers (hidden on another desktop) — the Choose button turns into Cancel,
// the page says why, and Cancel brings the dialog back. Fake osascript ($PROBE_OSASCRIPT), temp folders.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../lib/cdp.mjs';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'tend-choose-')));
const socket = `tend-choose-${process.pid}`;
process.env.TEND_OSASCRIPT = process.env.PROBE_OSASCRIPT ?? '';
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tend-choose-claude-'));
process.env.TEND_ACCOUNTS = ':';
const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {{ port: number }} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});
const { startServer } = await import('../../src/server.ts');
const token = 'ch-' + Math.random().toString(36).slice(2);
const srv = await startServer({ home, port, token, tmuxSocket: socket, notifyMode: 'stub' });
const browser = await openBrowser();
const page = await browser.page();
const fails = [];
try {
  await page.navigate(`http://127.0.0.1:${port}/?key=${token}&new=${encodeURIComponent(home)}`);
  await page.until(`return document.getElementById('newDlg')?.open`, 'the New session dialog', 15_000);
  await page.click('#newChoose');
  await page.until(`return document.getElementById('newChoose').textContent.includes('Cancel')`, 'Cancel while the window is open');
  const hint = await page.js(`return document.getElementById('newHint').textContent`);
  if (!/folder window is open/.test(hint)) fails.push(`hint: ${hint}`);
  await page.click('#newChoose');
  await page.until(`return document.getElementById('newChoose').textContent === 'Choose…'`, 'back to Choose after Cancel');
  const err = await page.js(`return document.getElementById('newErr').textContent`);
  if (err) fails.push(`error shown after cancel: ${err}`);
  const cwd = await page.js(`return document.getElementById('newCwd').value`);
  if (cwd !== home) fails.push(`the typed folder was changed: ${cwd}`);
  // a second Choose works (fresh helper), then closing the dialog cancels it too
  await page.click('#newChoose');
  await page.until(`return document.getElementById('newChoose').textContent.includes('Cancel')`, 'second Choose');
  await page.js(`document.getElementById('newDlg').close(); return true`);
  await page.until(`return document.getElementById('newChoose').textContent === 'Choose…'`, 'dialog close cancels the window', 8000);
} catch (e) {
  fails.push(String(e));
}
if (page.errors.length) fails.push(`page errors: ${page.errors.join(' | ')}`);
console.log(fails.length ? `FAIL\n${fails.join('\n')}` : 'ok: Choose → Cancel → Choose…, hint shown, typed path kept, dialog close cancels, no page errors');
browser.close();
await srv.close();
try {
  execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
} catch {}
rmSync(home, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
