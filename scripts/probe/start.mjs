#!/usr/bin/env node
// Probe: the New session dialog end to end in a real browser, as a person does it: open it from the empty page,
// type a folder, Start session; the session must appear and the dialog close. Fake claude, temp folders.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../lib/cdp.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'tend-start-')));
const socket = `tend-start-${process.pid}`;
process.env.TEND_CLAUDE_BIN = join(ROOT, 'test', 'fake-claude.mjs');
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tend-start-claude-'));
process.env.TEND_ACCOUNTS = ':';
const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {{ port: number }} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});
const { startServer } = await import('../../src/server.ts');
const token = 'st-' + Math.random().toString(36).slice(2);
const srv = await startServer({ home, port, token, tmuxSocket: socket, notifyMode: 'stub' });
const folder = join(home, 'test.tend');
mkdirSync(folder);
const browser = await openBrowser();
const page = await browser.page();
const fails = [];
const state = () => page.js(`return JSON.stringify({ open: document.getElementById('newDlg').open, btn: document.querySelector('#newForm button[type=submit], #newForm .primary')?.disabled, err: document.getElementById('newErr').textContent, rows: document.querySelectorAll('#list [data-id]').length, blank: document.getElementById('blank').hidden })`);
try {
  await page.navigate(`http://127.0.0.1:${port}/?key=${token}`);
  await page.until(`return !document.getElementById('blank').hidden`, 'the empty page', 15_000);
  await page.click('#blank button');
  await page.until(`return document.getElementById('newDlg').open`, 'dialog open');
  await page.js(`const i = document.getElementById('newCwd'); i.value = ${JSON.stringify(folder)}; i.dispatchEvent(new Event('input')); return true`);
  await new Promise((r) => setTimeout(r, 600));
  console.log('before start:', await state());
  await page.js(`document.getElementById('newForm').requestSubmit(); return true`);
  try {
    await page.until(`return !document.getElementById('newDlg').open && document.querySelectorAll('#list [data-id]').length === 1`, 'session shown, dialog closed', 10_000);
  } catch (e) {
    fails.push(`${e} — ${await state()}`);
  }
  console.log('after start:', await state());
} catch (e) {
  fails.push(String(e));
}
if (page.errors.length) fails.push(`page errors: ${page.errors.join(' | ')}`);
console.log(fails.length ? `FAIL\n${fails.join('\n')}` : 'ok: started from the empty page, dialog closed, session listed, no page errors');
browser.close();
await srv.close();
try {
  execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
} catch {}
rmSync(home, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
