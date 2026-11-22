#!/usr/bin/env node
// Full-journey browser e2e: a real headless Chrome drives the real UI against a real tend server (fake claude, temp
// repos, private tmux socket, no tokens spent). Walks every feature the way a person would and fails on any page
// error. Usage: node scripts/probe/e2e-browser.mjs   (CHROME_BIN overrides the Chrome path)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..', '..');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = realpathSync(mkdtempSync(join(tmpdir(), 'tend-e2e-')));
const socket = `tend-e2e-${process.pid}`;
process.env.TEND_CLAUDE_BIN = join(ROOT, 'test', 'fake-claude.mjs');
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tend-e2e-claude-'));
process.env.TEND_ACCOUNTS = ':';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const results = /** @type {{ n: number, name: string, ok: boolean, ms: number, error?: string }[]} */ ([]);
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {{ port: number }} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});
const git = (/** @type {string} */ dir, /** @type {string[]} */ ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

/** A tiny CDP client over the browser websocket (flattened sessions). */
async function chrome() {
  const profile = mkdtempSync(join(tmpdir(), 'tend-e2e-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1600,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    const t = setTimeout(() => reject(new Error(`Chrome did not start: ${err}`)), 15_000);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
  });
  const ws = new WebSocket(/** @type {string} */ (wsUrl));
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const waiting = new Map();
  /** @type {((m: any) => void)[]} */
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else for (const l of listeners) l(m);
  };
  /** @param {string} method @param {object} [params] @param {string} [sessionId] */
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return {
    send,
    on: (/** @type {(m: any) => void} */ fn) => listeners.push(fn),
    close: () => {
      try {
        ws.close();
      } catch {
        // gone
      }
      proc.kill('SIGKILL');
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

function png(/** @type {number[]} */ rgb) {
  const chunk = (/** @type {string} */ t, /** @type {Buffer} */ d) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([head, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 32 }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 32 }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

const { startServer } = await import('../../src/server.ts');
const { loadOrCreateToken } = await import('../../src/config.ts');
const port = /** @type {number} */ (await freePort());
const token = loadOrCreateToken(home);
const srv = await startServer({ home, port, token, tmuxSocket: socket, notifyMode: 'stub', watchIntervalMs: 500 });
const base = `http://127.0.0.1:${port}`;
const api = async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
  const r = await fetch(base + path, { ...init, headers: { 'x-tend-token': token, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};
const hookToken = () => readFileSync(join(home, 'hook-token'), 'utf8').trim();
const launchOf = (/** @type {string} */ id) => JSON.parse(readFileSync(join(home, 'sessions', id, 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0].headers['x-tend-launch'];
const hook = (/** @type {string} */ id, /** @type {object} */ body) => fetch(`${base}/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tend-token': hookToken(), 'x-tend-session': id, 'x-tend-launch': launchOf(id) }, body: JSON.stringify(body) });
const keys = (/** @type {string} */ id, /** @type {string} */ text) => fetch(`${base}/api/sessions/${id}/keys`, { method: 'POST', headers: { 'x-tend-token': token }, body: text });

// a repo for worktree sessions
const repo = join(home, 'shop');
mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.name', 'E2E');
git(repo, 'config', 'user.email', 'e2e@example.com');
git(repo, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'README.md'), '# shop\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'init');

const cdp = await chrome();
const pageErrors = /** @type {string[]} */ ([]);
let failure = '';
try {
  const { targetId } = /** @type {any} */ (await cdp.send('Target.createTarget', { url: 'about:blank' }));
  const { sessionId } = /** @type {any} */ (await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  const s = (/** @type {string} */ m, /** @type {object} */ p = {}) => cdp.send(m, p, sessionId);
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args.map((/** @type {any} */ a) => a.value ?? a.description).join(' '));
    if (m.method === 'Page.javascriptDialogOpening') void s('Page.handleJavaScriptDialog', { accept: true }); // confirms: yes
  });
  await s('Runtime.enable');
  await s('Page.enable');
  /** Evaluate in the page (awaits promises). @param {string} expr */
  const js = async (expr) => {
    const r = /** @type {any} */ (await s('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }));
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  /** @param {string} expr a body returning truthy when ready @param {string} what */
  const until = async (expr, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js(expr)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for: ${what}`);
  };
  const click = (/** @type {string} */ sel, /** @type {string} */ text = '') => js(`
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => !${JSON.stringify(text)} || e.textContent.includes(${JSON.stringify(text)}));
    if (!el) throw new Error('no element ' + ${JSON.stringify(sel + ' ' + text)});
    el.click(); return true;`);
  const VK = /** @type {Record<string, number>} */ ({ Enter: 13, Escape: 27 });
  const key = async (/** @type {string} */ k, /** @type {string} */ code, /** @type {number} */ modifiers = 0) => {
    const text = k === 'Enter' ? '\r' : k.length === 1 && !modifiers ? k : undefined;
    const vk = VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
    await s('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
  };
  /** Type into the focused element key by key (xterm reads key events, not input events). @param {string} text */
  const typeText = async (text) => {
    for (const ch of text) await s('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
  };
  const viewOf = async (/** @type {string} */ id) => (/** @type {any[]} */ (await api('/api/sessions'))).find((v) => v.id === id);

  /** @param {string} name @param {() => Promise<void>} fn */
  const check = async (name, fn) => {
    const n = ++step;
    const t0 = Date.now();
    try {
      await fn();
      results.push({ n, name, ok: true, ms: Date.now() - t0 });
      process.stdout.write(`  ✔ ${n}. ${name}\n`);
    } catch (e) {
      results.push({ n, name, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
      process.stdout.write(`  ✖ ${n}. ${name}: ${e instanceof Error ? e.message : e}\n`);
      const seen = await js(`return { header: document.getElementById('dh')?.textContent.replace(/\\s+/g, ' ').trim(), note: document.getElementById('termNote')?.textContent }`).catch(() => null);
      process.stdout.write(`      page: ${JSON.stringify(seen)}\n`);
    }
  };

  let wt = ''; // worktree session id
  let ip = ''; // in-place session id

  await check('sign-in link opens the app, then the URL is cleaned of the key', async () => {
    await s('Page.navigate', { url: `${base}/?key=${token}` });
    await until(`return document.querySelector('[data-new]') !== null`, 'the page');
    if (await js(`return location.search.includes('key=')`)) throw new Error('key left in the URL');
    await until(`return document.getElementById('blank') && !document.getElementById('blank').hidden`, 'the empty state');
  });

  await check('New session: dialog, git hint, own worktree → a live terminal', async () => {
    await click('[data-new]');
    await until(`return document.getElementById('newDlg').open`, 'dialog');
    await js(`const i = document.getElementById('newCwd'); i.value = ${JSON.stringify(repo)}; i.dispatchEvent(new Event('input')); return true;`);
    await js(`const n = document.getElementById('newName'); n.value = 'checkout'; n.dispatchEvent(new Event('input')); return true;`);
    await until(`return document.getElementById('newHint').textContent.includes('tend/checkout-')`, 'branch hint');
    await click('#newGo');
    await until(`return !document.getElementById('newDlg').open`, 'dialog closed');
    await until(`return document.querySelector('#termHost .xterm-rows')?.textContent.includes('fake claude')`, 'terminal shows claude');
    const list = /** @type {any[]} */ (await api('/api/sessions'));
    wt = list.find((v) => v.name === 'checkout').id;
    if ((await viewOf(wt)).workspace.mode !== 'worktree') throw new Error('not a worktree');
    await until(`return document.getElementById('dh').textContent.includes('worktree')`, 'worktree badge');
  });

  await check('ready: the session goes idle (SessionStart hook)', async () => {
    await until(`return document.getElementById('dh').textContent.includes('Idle')`, 'Idle in header');
  });

  await check('typing in the terminal reaches Claude; briefing fills from its turn', async () => {
    await s('Runtime.evaluate', { expression: `document.querySelector('#termHost .xterm-helper-textarea').focus()` });
    await typeText('hello there');
    await key('Enter', 'Enter');
    await until(`return document.querySelector('#termHost .xterm-rows').textContent.includes('hello there')`, 'typed text on screen');
    await until(`return document.getElementById('brief').textContent.includes('Goal')`, 'briefing goal', 10_000);
  });

  await check('permission card: risk label, Allow reaches Claude, card closes', async () => {
    await keys(wt, 'bash npm install zod\r');
    await until(`return document.getElementById('decision').textContent.includes('npm install zod')`, 'card');
    if (!(await js(`return document.getElementById('decision').textContent.includes('Medium risk · Package install')`))) throw new Error('risk label');
    await until(`return document.querySelector('#list .row')?.textContent.includes('Wants to run npm install zod')`, 'row summary');
    await click('#decision button', 'Allow');
    await until(`return document.getElementById('decision').hidden || !document.getElementById('decision').textContent.includes('npm install zod')`, 'card gone');
    const a = readFileSync(join(home, 'sessions', wt, 'answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    if (a.at(-1).answer.hookSpecificOutput.decision.behavior !== 'allow') throw new Error('claude did not get allow');
  });

  await check('high risk: Allow needs Confirm, no shortcut; deny with a note', async () => {
    await keys(wt, 'bash git push --force origin main\r');
    await until(`return document.getElementById('decision').textContent.includes('High risk · Force push')`, 'high-risk card');
    if (await js(`return [...document.querySelectorAll('#decision kbd')].length > 0`)) throw new Error('a shortcut on a high-risk card');
    await click('#decision button', 'Allow…');
    await until(`return document.getElementById('decision').textContent.includes('Confirm allow')`, 'armed');
    await js(`const n = document.querySelector('#decision .dnote'); n.value = 'not on main'; return true;`);
    await click('#decision button', 'Deny');
    await until(`return document.getElementById('decision').hidden`, 'card gone');
    const a = readFileSync(join(home, 'sessions', wt, 'answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const d = a.at(-1).answer.hookSpecificOutput.decision;
    if (d.behavior !== 'deny' || d.message !== 'not on main') throw new Error(`got ${JSON.stringify(d)}`);
  });

  await check('question card: clicking an option answers it', async () => {
    await keys(wt, 'ask\r');
    await until(`return document.getElementById('decision').textContent.includes('Which color')`, 'question');
    await click('#decision .btn.opt', 'Blue');
    await until(`return document.getElementById('decision').hidden`, 'answered');
    const a = readFileSync(join(home, 'sessions', wt, 'answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    if (!JSON.stringify(a.at(-1).answer).includes('Blue')) throw new Error('answer not sent');
  });

  await check('plan card: Approve plan', async () => {
    await keys(wt, 'plan\r');
    await until(`return document.getElementById('decision').textContent.includes('Plan ready for approval')`, 'plan');
    await click('#decision button', 'Approve plan');
    await until(`return document.getElementById('decision').hidden`, 'approved');
  });

  await check('keyboard: D denies a card from outside the terminal (after the 500 ms guard)', async () => {
    await keys(wt, 'bash ls -la\r');
    await until(`return document.getElementById('decision').textContent.includes('ls -la')`, 'card');
    await js(`document.activeElement.blur(); return true;`);
    await sleep(600);
    await key('d', 'KeyD');
    await until(`return document.getElementById('decision').hidden`, 'denied by key');
  });

  await check('usage and context from the status line: pill, popover, header facts, ring', async () => {
    await keys(wt, 'status 74 41\r');
    await until(`return document.getElementById('dh').textContent.includes('context 74%')`, 'context in header', 10_000);
    await until(`return document.querySelector('.upill')?.textContent.includes('41%')`, 'usage pill', 20_000);
    await click('.upill');
    await until(`return document.querySelector('.upop')?.textContent.includes('5 hours')`, 'popover');
    await until(`return document.querySelector('#list .ring') !== null`, 'context ring');
    await key('Escape', 'Escape');
  });

  await check('attach by paste: the path is typed at the prompt (not sent), chip appears', async () => {
    const b64 = png([200, 40, 40]).toString('base64');
    await js(`
      document.activeElement?.blur?.();
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
      return true;`);
    await until(`return document.querySelector('#mbar .chip') !== null`, 'chip');
    await until(`return document.querySelector('#termHost .xterm-rows').textContent.includes('.tend/attachments/')`, 'path at the prompt');
    await sleep(500);
    const prompts = (await api(`/api/sessions/${wt}/briefing`)).instructions.length;
    await sleep(500);
    if ((await api(`/api/sessions/${wt}/briefing`)).instructions.length !== prompts) throw new Error('the prompt was submitted');
    if (git((await viewOf(wt)).workspace.worktree, 'status', '--porcelain').includes('.tend')) throw new Error('attachment not excluded from git');
  });

  await check('Review tab: changed files, rendered Markdown with changes marked, a diff, a comment sent to Claude', async () => {
    const w = (await viewOf(wt)).workspace.worktree;
    writeFileSync(join(w, 'README.md'), '# shop\n\nNow with checkout.\n');
    await until(`return /Review\\s*\\d/.test(document.querySelector('.dtabs').textContent)`, 'Review count', 20_000);
    await click('.dtabs button', 'Review');
    await until(`return [...document.querySelectorAll('.rvrow')].some((r) => r.dataset.path === 'README.md')`, 'tree row');
    await js(`[...document.querySelectorAll('.rvrow')].find((r) => r.dataset.path === 'README.md').click()`);
    await until(`return [...document.querySelectorAll('article.md .mdnew')].some((b) => b.textContent.includes('Now with checkout'))`, 'rendered block marked as changed');
    await click('.rvmodes button', 'Diff');
    await until(`return [...document.querySelectorAll('.half.add code')].some((l) => l.textContent.includes('Now with checkout'))`, 'side-by-side diff line');
    await click('.rvstyle button', 'Unified');
    await until(`return [...document.querySelectorAll('.rl.add code')].some((l) => l.textContent.includes('Now with checkout'))`, 'unified diff line');
    await js(`document.querySelector('.rl.add .rn.can').click()`);
    await js(`document.querySelector('.rcompose textarea').value = 'Say what checkout supports.'`);
    await click('.rcompose button', 'Add comment');
    await until(`return document.querySelectorAll('.rc').length === 1 && !document.querySelector('.rvfoot').hidden`, 'comment card');
    await until(`return !document.querySelector('.rvfoot .btn.pri').disabled`, 'send enabled (idle)', 15_000);
    await click('.rvfoot button', 'Send review to Claude');
    await until(`return document.querySelector('.dtabs button.on')?.textContent === 'Terminal'`, 'back on the terminal');
    await until(`return [...document.querySelectorAll('.xterm-rows > div')].some((d) => d.textContent.includes('Say what checkout supports.'))`, 'the review reached Claude', 10_000);
  });

  await check('a second session in place; overlap-free list grouping; switching sessions', async () => {
    const dir = join(home, 'notes');
    mkdirSync(dir);
    await click('[data-new]');
    await until(`return document.getElementById('newDlg').open`, 'dialog');
    await js(`const i = document.getElementById('newCwd'); i.value = ${JSON.stringify(dir)}; i.dispatchEvent(new Event('input')); return true;`);
    await until(`return document.getElementById('newHint').textContent.includes('runs in the folder itself')`, 'in-place hint');
    await click('#newGo');
    await until(`return !document.getElementById('newDlg').open`, 'closed');
    ip = (/** @type {any[]} */ (await api('/api/sessions'))).find((v) => v.name === 'notes').id;
    await until(`return document.getElementById('dh').textContent.includes('in place')`, 'in-place badge');
    await click('#list [data-id]', 'checkout');
    await until(`return document.getElementById('dh').textContent.includes('checkout')`, 'switched');
  });

  await check('⌘K palette: filter and jump to a session', async () => {
    await key('K', 'KeyK', 12); // ⌘⇧K: opens the palette whether or not the terminal has focus
    await until(`return document.querySelector('dialog.palette') !== null`, 'palette');
    await typeText('notes');
    await until(`return document.querySelector('.plist li.on')?.textContent.includes('notes')`, 'filtered');
    await key('Enter', 'Enter');
    await until(`return document.getElementById('dh').textContent.includes('notes')`, 'jumped');
  });

  await check('stuck: the same failure 3× shows the error verbatim under Problems', async () => {
    for (let i = 0; i < 3; i++) await hook(ip, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'npm ERR! Missing script: "lint"', is_interrupt: false });
    await until(`return document.getElementById('decision').textContent.includes('Missing script')`, 'stuck card');
    await click('#seg button', 'For you');
    await until(`return document.getElementById('list').textContent.includes('Stuck · same Bash error 3×')`, 'problem row');
    await hook(ip, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    await until(`return !document.getElementById('list').textContent.includes('Stuck ·')`, 'cleared');
  });

  await check('focus windows: a held notification, "Show now" releases it', async () => {
    await keys(ip, 'bash echo hi\r');
    await until(`return document.getElementById('calm').textContent.includes('held')`, 'held indicator');
    const before = existsSync(join(home, 'notify.jsonl')) ? readFileSync(join(home, 'notify.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
    await click('#calm .cheld');
    await until(`return !document.getElementById('calm').textContent.includes('held')`, 'released');
    const after = readFileSync(join(home, 'notify.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    if (after <= before) throw new Error('nothing was sent');
    await click('#list [data-id]', 'notes');
    await click('#decision button', 'Allow');
  });

  await check('Pace settings save; Today shows the wrap-up', async () => {
    await click('#calm button', 'Pace');
    await until(`return document.querySelector('form.cpop') !== null`, 'pace form');
    await js(`const n = document.querySelectorAll('form.cpop input[type=number]'); n[0].value = '20'; document.querySelector('form.cpop').requestSubmit(); return true;`);
    await until(`return document.querySelector('form.cpop') === null`, 'saved');
    if ((await api('/api/settings')).focus.minutes !== 20) throw new Error('not saved');
    await click('#calm button', 'Today');
    await until(`return document.querySelector('.cpop')?.textContent.includes('Decisions')`, 'today');
    const decisions = await js(`return Number([...document.querySelectorAll('.crows dt')].find((d) => d.textContent === 'Decisions').nextElementSibling.textContent)`);
    if (!(decisions >= 5)) throw new Error(`decisions ${decisions}`);
    await key('Escape', 'Escape');
  });

  await check('Pause → Resume keeps the worktree work; crash is flagged; Archive hides', async () => {
    await click('#seg button', 'All sessions');
    await click('#list [data-id]', 'checkout');
    await until(`return document.querySelector('#dh [data-act="pause"]') !== null`, 'pause button');
    await click('#dh [data-act="pause"]');
    await until(`return document.getElementById('dh').textContent.includes('Paused')`, 'paused', 15_000);
    await click('#dh [data-act="resume"]');
    await until(`return document.getElementById('dh').textContent.includes('worktree') && !document.getElementById('dh').textContent.includes('Paused')`, 'resumed', 15_000);
    const w = (await viewOf(wt)).workspace.worktree;
    if (!readFileSync(join(w, 'README.md'), 'utf8').includes('Now with checkout')) throw new Error('work lost across pause');
    execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-session', '-t', `=tend-${ip}`]);
    await until(`return document.getElementById('list').textContent.includes('Ended unexpectedly')`, 'crash flagged', 10_000);
    await click('#list [data-id]', 'notes');
    await until(`return document.querySelector('#dh [data-act="archive"]') !== null`, 'archive button');
    await click('#dh [data-act="archive"]');
    await until(`return !document.getElementById('list').textContent.includes('notes')`, 'archived', 10_000);
  });

  await check('no page errors during the whole journey', async () => {
    if (pageErrors.length) throw new Error(pageErrors.slice(0, 3).join(' | '));
  });
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
} finally {
  cdp.close();
  await srv.close();
  try {
    execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // none
  }
  rmSync(join('/private/tmp', `tmux-${userInfo().uid}`, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(/** @type {string} */ (process.env.CLAUDE_CONFIG_DIR), { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n[e2e-browser] ${results.length - failed.length}/${results.length} passed${failure ? `; aborted: ${failure}` : ''}\n`);
process.exit(failed.length || failure ? 1 : 0);
