#!/usr/bin/env node
// Production soak: real Claude (haiku) doing real multi-turn work in 4 sessions for SOAK_MINUTES (default 60), driven
// through tend in a real headless Chrome the way a developer would, with failures injected (tend restarts, pause/
// resume, a killed session). An independent oracle compares what tend shows with what Claude's screen shows every
// 15 s, and a UI oracle checks the page itself never freezes or goes stale (main-thread blocks, ping, what the page
// shows vs the server, the terminal vs Claude's real screen). The person also reviews changes in the Review tab and
// sends review comments to Claude. Works only on temp copies; never the user's repos. Writes a report (JSON + Markdown) and exits non-zero on
// any finding. Usage: SOAK_MINUTES=60 node scripts/perf/soak.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../lib/cdp.mjs';
import { createUiOracle } from '../lib/soak-ui.mjs';
import { FOLLOW_UPS, INVENTORY_PY, png, TASKS, treeHash } from '../lib/soak-tasks.mjs';

const MINUTES = Number(process.env.SOAK_MINUTES ?? 60);
const END = Date.now() + MINUTES * 60_000;
const START = Date.now();
const ROOT = join(import.meta.dirname, '..', '..');
const OUT = process.env.SOAK_OUT ?? join(ROOT, 'docs', 'versions', 'v1.0');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'tend-soak-')));
const socket = `tend-soak-${process.pid}`;
process.env.TEND_HOME = home;
process.env.TEND_CLAUDE_BIN = 'claude';
process.env.TEND_CLAUDE_ARGS = '--model haiku --permission-mode default';
process.env.TEND_ACCOUNTS = ':';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const t = () => `${((Date.now() - START) / 60_000).toFixed(1).padStart(5)}m`;
const log = (/** @type {string} */ m) => process.stdout.write(`[soak ${t()}] ${m}\n`);
const rnd = (/** @type {number} */ a, /** @type {number} */ b) => a + Math.random() * (b - a);
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const git = (/** @type {string} */ dir, /** @type {string[]} */ ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {{ port: number }} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});

/** @type {{ at: string, kind: string, session?: string, detail: string, screen?: string }[]} */
const findings = [];
/** @type {{ at: string, what: string }[]} */
const timeline = [];
const metrics = { api: /** @type {number[]} */ ([]), keys: /** @type {number[]} */ ([]), rss: /** @type {number[]} */ ([]), ticks: 0, turns: 0, cards: { allow: 0, deny: 0, terminal: 0, question: 0, plan: 0 }, restarts: 0,
  ui: { ping: /** @type {number[]} */ ([]), longest: 0, blocks: 0, reviews: 0, filesOpened: 0, reviewsSent: 0, reviewRender: /** @type {number[]} */ ([]) } };
const find = (/** @type {string} */ kind, /** @type {string} */ detail, /** @type {string} */ session = '', /** @type {string} */ screen = '') => {
  findings.push({ at: t(), kind, session, detail, ...(screen ? { screen } : {}) });
  log(`FINDING ${kind}${session ? ` [${session}]` : ''}: ${detail}`);
};
const mark = (/** @type {string} */ what) => {
  timeline.push({ at: t(), what });
  log(what);
};

// ---- projects: temp copies only ------------------------------------------------
const tendCopy = join(home, 'tend-copy');
execFileSync('git', ['clone', '-q', '--no-hardlinks', ROOT, tendCopy]);
git(tendCopy, 'config', 'user.name', 'Soak');
git(tendCopy, 'config', 'user.email', 'soak@example.com');
git(tendCopy, 'config', 'commit.gpgsign', 'false');
const inventory = join(home, 'inventory');
mkdirSync(inventory);
writeFileSync(join(inventory, 'inventory.py'), INVENTORY_PY);
writeFileSync(join(inventory, 'README.md'), '# inventory\n');
git(inventory, 'init', '-q', '-b', 'main');
git(inventory, 'config', 'user.name', 'Soak');
git(inventory, 'config', 'user.email', 'soak@example.com');
git(inventory, 'config', 'commit.gpgsign', 'false');
git(inventory, 'add', '-A');
git(inventory, 'commit', '-q', '-m', 'init');
const notes = join(home, 'notes');
mkdirSync(notes);

const { startServer } = await import('../../src/server.ts');
const { loadOrCreateToken } = await import('../../src/config.ts');
const port = /** @type {number} */ (await freePort());
const token = loadOrCreateToken(home);
const boot = () => startServer({ home, port, token, tmuxSocket: socket, notifyMode: 'stub' });
let srv = await boot();
const base = `http://127.0.0.1:${port}`;
const api = async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
  const r = await fetch(base + path, { ...init, headers: { 'x-tend-token': token, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};
const sessions = async () => /** @type {any[]} */ (await api('/api/sessions'));
const screenOf = async (/** @type {string} */ id) => {
  const r = await fetch(`${base}/api/sessions/${id}/snapshot`, { headers: { 'x-tend-token': token } });
  return r.ok ? plain(Buffer.from(await r.text(), 'base64').toString('utf8')) : '';
};
const keys = (/** @type {string} */ id, /** @type {string} */ s) => fetch(`${base}/api/sessions/${id}/keys`, { method: 'POST', headers: { 'x-tend-token': token }, body: s });

const DIALOG = /Do you want to proceed\?|Esc to cancel|Enter to confirm|^\s*❯\s*\d+\.|trust this folder/m;
const WORKING = /esc to interrupt|^\s*[·✢✳✶✻✽*]\s+[^\n]*…\s*\(\d/im;
const lastLines = (/** @type {string} */ s, n = 14) => s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');

const browser = await openBrowser();
const page = await browser.page();
/** What the person is doing in the page right now (for freeze reports). */
let doing = 'starting';
const openApp = async () => {
  await page.navigate(`${base}/?key=${token}`);
  await page.until(`return document.querySelector('[data-new]') !== null`, 'app', 15_000);
  // main-thread blocks over 200 ms, kept for the UI oracle
  await page.js(`window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 200) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask' }); return true;`);
};
await openApp();

// ---- create the four sessions through the browser -------------------------------
/** @typedef {{ name: string, cwd: string, isolate: boolean, id: string, turn: number, sentAt: number, lastStopRow: number, plan: boolean, hold?: boolean }} P */
/** @type {P[]} */
const plan = [
  { name: 'slugs', cwd: tendCopy, isolate: true, id: '', turn: 0, sentAt: 0, lastStopRow: 0, plan: false },
  { name: 'kebab', cwd: tendCopy, isolate: true, id: '', turn: 0, sentAt: 0, lastStopRow: 0, plan: false },
  { name: 'inventory', cwd: inventory, isolate: true, id: '', turn: 0, sentAt: 0, lastStopRow: 0, plan: false },
  { name: 'notes', cwd: notes, isolate: false, id: '', turn: 0, sentAt: 0, lastStopRow: 0, plan: false },
];
for (const p of plan) {
  await page.click('[data-new]');
  await page.until(`return document.getElementById('newDlg').open`, 'dialog');
  await page.js(`const i = document.getElementById('newCwd'); i.value = ${JSON.stringify(p.cwd)}; i.dispatchEvent(new Event('input'));
    const n = document.getElementById('newName'); n.value = ${JSON.stringify(p.name)}; n.dispatchEvent(new Event('input'));
    document.getElementById('newIso').checked = ${p.isolate}; return true;`);
  await sleep(500);
  await page.click('#newGo');
  await page.until(`return !document.getElementById('newDlg').open`, 'created', 15_000);
  p.id = (await sessions()).find((v) => v.name === p.name).id;
  mark(`created ${p.name} (${p.isolate ? 'worktree' : 'in place'})`);
  await sleep(3000);
}

/** Accept Claude's trust dialog for these throwaway temp copies (tend itself never does). */
/** @param {P} p */
async function acceptTrustIfShown(p) {
  const scr = await screenOf(p.id);
  if (!/trust this folder/i.test(scr)) return false;
  await sleep(800);
  await keys(p.id, '\x1b[B');
  await sleep(300);
  await keys(p.id, '\r');
  mark(`trust dialog accepted for ${p.name} (temp copy)`);
  return true;
}

// ---- the person: answer cards, send the next turn ---------------------------------
// one pair of hands: a card answer, a review and a typed turn never interleave on the page
let hands = Promise.resolve();
const withHands = (/** @type {() => Promise<any>} */ fn) => {
  const run = hands.then(fn, fn);
  hands = run.catch(() => undefined);
  return run;
};
const answering = new Set();
/** @param {string} id */
async function selectInBrowser(id) {
  await page.click('#seg button', 'All sessions').catch(() => undefined);
  await page.js(`document.querySelector('#list [data-id="${id}"]')?.click(); return true;`);
  await page.until(`return document.getElementById('dh').textContent.length > 0`, 'header');
}
/** @param {P} p @param {any} d */
async function answer(p, d) {
  if (answering.has(d.id)) return;
  answering.add(d.id);
  await sleep(rnd(2000, 12_000)); // a person reads the card
  try {
    const v = (await sessions()).find((x) => x.id === p.id);
    if (!v?.decisions?.some((/** @type {any} */ x) => x.id === d.id)) return; // answered meanwhile (terminal) or settled
    await withHands(() => answerOnPage(p, d));
  } catch (e) {
    // tend restarting (a planned failure): the card comes back or Claude's own dialog takes over; try again later
    if (!restarting && !/fetch failed|ECONNREFUSED/.test(String(e))) find('card-answer', `could not answer ${d.kind} ${d.command ?? ''}: ${e instanceof Error ? e.message : e}`, p.name);
  } finally {
    answering.delete(d.id);
  }
}
/** @param {P} p @param {any} d */
async function answerOnPage(p, d) {
  {
    const v = (await sessions()).find((x) => x.id === p.id);
    if (!v?.decisions?.some((/** @type {any} */ x) => x.id === d.id)) return; // answered while waiting for the hands
    await selectInBrowser(p.id);
    await page.until(`return document.getElementById('decision').textContent.length > 0 && !document.getElementById('decision').hidden`, 'card', 10_000);
    if (d.kind === 'question') {
      await page.click('#decision .btn.opt');
      metrics.cards.question++;
    } else if (d.kind === 'plan') {
      await page.click('#decision button', 'Approve plan');
      metrics.cards.plan++;
    } else if (d.risk?.level === 'high') {
      await page.js(`const n = document.querySelector('#decision .dnote'); if (n) n.value = 'Not now, leave it.'; return true;`);
      await page.click('#decision button', 'Deny');
      metrics.cards.deny++;
    } else if (Math.random() < 0.2) {
      await keys(p.id, '\r'); // answer in Claude's own dialog instead: first answer wins
      metrics.cards.terminal++;
    } else {
      await page.click('#decision button', 'Allow');
      metrics.cards.allow++;
    }
  }
}

/** @param {P} p */
async function sendTurn(p) {
  const list = TASKS[p.name];
  const turn = p.turn < list.length ? list[p.turn] : { text: FOLLOW_UPS[(p.turn - list.length) % FOLLOW_UPS.length] };
  p.turn++;
  await selectInBrowser(p.id);
  doing = `typing a turn into ${p.name}`;
  await page.click('.dtabs button', 'Terminal').catch(() => undefined);
  if (turn.plan) {
    await keys(p.id, '\x1b[Z');
    await sleep(400);
    await keys(p.id, '\x1b[Z');
    await sleep(800);
  }
  // type the prompt into the terminal through the page (a real keyboard path)
  await page.js(`document.querySelector('#termHost .xterm-helper-textarea')?.focus(); return true;`);
  await page.typeText(turn.text);
  if (turn.attach) {
    const b64 = png(turn.attach).toString('base64');
    await page.js(`
      document.activeElement?.blur?.();
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
      return true;`);
    await sleep(2500);
    await page.js(`document.querySelector('#termHost .xterm-helper-textarea')?.focus(); return true;`);
  }
  await page.key('Enter', 'Enter');
  doing = 'idle';
  p.sentAt = Date.now();
  metrics.turns++;
  mark(`${p.name}: turn ${p.turn} sent`);
}

// ---- the person reviews what Claude changed ------------------------------------------------
/** @param {P} p */
async function reviewSession(p) {
  metrics.ui.reviews++;
  await selectInBrowser(p.id);
  doing = `reviewing ${p.name}`;
  await page.click('.dtabs button', 'Review');
  const tree = await page.until(`return document.querySelectorAll('.rvrow').length > 0 || /No files|Nothing/.test(document.querySelector('.rvtree')?.textContent ?? '')`, 'review tree', 10_000).then(() => true, () => false);
  if (!tree) find('review', 'the Review tab showed no file tree within 10 s', p.name, String(await page.js(`return document.getElementById('review').textContent.slice(0, 300)`)));
  const rows = /** @type {string[]} */ (await page.js(`return [...document.querySelectorAll('.rvrow:not(.dir)')].map((r) => r.dataset.path)`));
  const pick = rows.sort(() => Math.random() - 0.5).slice(0, 3);
  for (const path of pick) {
    const t0 = Date.now();
    await page.js(`[...document.querySelectorAll('.rvrow')].find((r) => r.dataset.path === ${JSON.stringify(path)})?.click(); return true;`);
    const shown = await page.until(`const c = document.querySelector('.rvcontent'); return c && c.textContent.length > 0 && !/^Loading/.test(c.textContent) && document.querySelector('.rvpath')?.title === ${JSON.stringify(path)}`, 'file shown', 10_000).then(() => true, () => false);
    metrics.ui.filesOpened++;
    metrics.ui.reviewRender.push(Date.now() - t0);
    // tend's own notes (not the file's text) say when something went wrong
    const note = String(await page.js(`return [...document.querySelectorAll('.rvcontent > .rnote')].map((n) => n.textContent).join(' | ')`));
    if (!shown) find('review', `${path} did not show within 10 s`, p.name, note);
    else if (/Could not|internal error|Not a changed file|Request failed/i.test(note)) find('review', `${path}: ${note.slice(0, 160)}`, p.name);
    // look at it another way, like a person would
    const modes = /** @type {string[]} */ (await page.js(`return [...document.querySelectorAll('.rvmodes button')].map((b) => b.textContent)`));
    if (modes.length > 1) {
      const m = modes[Math.floor(Math.random() * modes.length)];
      await page.click('.rvmodes button', m);
      await page.until(`return !/^Loading/.test(document.querySelector('.rvcontent')?.textContent ?? '')`, `${path} as ${m}`, 10_000).catch(() => find('review', `${path} as ${m} did not show within 10 s`, p.name));
    }
    if (Math.random() < 0.3) await page.click('.rvstyle button', Math.random() < 0.5 ? 'Split' : 'Unified').catch(() => undefined);
    if (Math.random() < 0.6) await page.js(`const v = document.querySelector('.rvviewed input'); if (v && !v.closest('[hidden]') && !v.checked) v.click(); return true;`);
    await sleep(rnd(800, 2500));
  }
  // sometimes: comment on a changed line and send the review instead of the next turn
  const v = (await sessions()).find((x) => x.id === p.id);
  // a changed file's diff, where comments go
  const changed = /** @type {string | null} */ (await page.js(`return [...document.querySelectorAll('.rvrow')].find((r) => r.querySelector('.stM, .stA'))?.dataset.path ?? null`));
  if (changed && Math.random() < 0.35) {
    await page.js(`[...document.querySelectorAll('.rvrow')].find((r) => r.dataset.path === ${JSON.stringify(changed)})?.click(); return true;`);
    await sleep(600);
    await page.click('.rvmodes button', 'Diff').catch(() => undefined);
    await page.until(`return document.querySelector('.rl.add .rn.can, .half.add .rn.can') !== null`, 'diff lines', 8000).catch(() => undefined);
  }
  const commentable = await page.js(`return document.querySelector('.rl.add .rn.can, .half.add .rn.can') !== null`);
  if (commentable && changed && (v.state.status === 'idle' || v.state.status === 'working') && !v.decisions?.length) {
    const note = `Review note ${p.turn}: keep this but add a one-line comment above it.`;
    await page.js(`document.querySelector('.rl.add .rn.can, .half.add .rn.can').click(); return true;`);
    await page.until(`return document.querySelector('.rcompose textarea') !== null`, 'comment box');
    await page.js(`document.querySelector('.rcompose textarea').value = ${JSON.stringify(note)}; return true;`);
    await page.click('.rcompose button', 'Add comment');
    await page.until(`return !document.querySelector('.rvfoot').hidden`, 'review footer');
    await page.click('.rvfoot button', 'Send review to Claude');
    const sent = await page.until(`return /Review sent/.test(document.getElementById('termNote').textContent)`, 'review sent', 8000).then(() => true, () => false);
    if (!sent) {
      const why = String(await page.js(`return document.getElementById('termNote').textContent || document.querySelector('.rvfoot')?.textContent || ''`));
      // refused because Claude put up a dialog meanwhile is correct behaviour; anything else is a finding
      if (!/answer it first/.test(why)) find('review', `send review failed: ${why}`, p.name);
      await page.js(`const d = [...document.querySelectorAll('.rvfoot button')].find((b) => b.textContent === 'Discard'); window.confirm = () => true; d?.click(); return true;`);
    } else {
      metrics.ui.reviewsSent++;
      metrics.turns++;
      p.sentAt = Date.now();
      const arrived = await (async () => {
        for (let i = 0; i < 20; i++) {
          if ((await screenOf(p.id)).includes(`Review note ${p.turn}`)) return true;
          await sleep(500);
        }
        return false;
      })();
      if (!arrived) {
        // where did it go? (another session's terminal would be the worst case)
        const elsewhere = [];
        for (const o of plan) if (o !== p && (await screenOf(o.id)).includes(`Review note ${p.turn}`)) elsewhere.push(o.name);
        const ui = String(await page.js(`return (document.querySelector('#strip .sel')?.title ?? '') + ' | ' + (document.querySelector('.rvpath')?.title ?? '')`));
        find('review', `a sent review never appeared in Claude's terminal${elsewhere.length ? ` (it went to ${elsewhere.join(', ')})` : ''}; page: ${ui}`, p.name, lastLines(await screenOf(p.id)));
      }
      mark(`${p.name}: review sent`);
    }
  }
  await page.click('.dtabs button', 'Terminal').catch(() => undefined);
  doing = 'idle';
}

// ---- the UI oracle: the page itself (scripts/lib/soak-ui.mjs) -------------------------
const uiOracle = createUiOracle({ page, sessions, screenOf, plan, find, strike: (id, key, ok) => strike(id, key, ok), metrics, sleep, doing: () => doing });

// ---- the oracle: tend vs the screen ---------------------------------------------------
/** @type {Map<string, Record<string, number>>} */
const strikes = new Map();
/** @param {string} id @param {string} key @param {boolean} ok */
function strike(id, key, ok) {
  const s = strikes.get(id) ?? {};
  s[key] = ok ? 0 : (s[key] ?? 0) + 1;
  strikes.set(id, s);
  return s[key];
}
async function oracle() {
  metrics.ticks++;
  const t0 = performance.now();
  const list = await sessions();
  metrics.api.push(performance.now() - t0);
  metrics.rss.push(process.memoryUsage().rss / 1e6);
  for (const p of plan) {
    const v = list.find((x) => x.id === p.id);
    if (!v) {
      find('missing', 'session disappeared from tend', p.name);
      continue;
    }
    if (v.paused || v.state.status === 'ended' || p.hold) continue;
    const scr = await screenOf(p.id);
    const tail = lastLines(scr);
    const dialog = DIALOG.test(tail);
    const working = WORKING.test(tail);
    const st = v.state.status;
    if (strike(p.id, 'dialog', !(dialog && st !== 'needs_you')) >= 2) find('state', `Claude shows a dialog, tend says ${st}`, p.name, tail);
    if (strike(p.id, 'busy', !(working && !dialog && (st === 'idle' || st === 'needs_you') && !v.decisions?.length)) >= 2) find('state', `Claude is working, tend says ${st}`, p.name, tail);
    if (strike(p.id, 'stale', !(!working && !dialog && st === 'working')) >= 4) find('state', 'tend says working, Claude has been idle for a minute', p.name, tail);
    if (strike(p.id, 'ghost', !(v.decisions?.length && !dialog)) >= 3) find('card', `a card (${v.decisions?.[0]?.kind}) with no dialog on Claude's screen`, p.name, tail);
    if (strike(p.id, 'nocard', !(st === 'needs_you' && !v.decisions?.length && !dialog && v.state.need !== 'trust')) >= 3) find('card', 'needs you, but no card and no dialog', p.name, tail);
  }
  // keystroke round trip (an empty body: measures the route, types nothing)
  const k0 = performance.now();
  await keys(plan[0].id, '');
  metrics.keys.push(performance.now() - k0);
}

// ---- failures we inject ------------------------------------------------------------
const chaos = [
  { at: 0.22, name: 'restart tend (sessions keep running)', run: restartTend },
  { at: 0.38, name: 'pause and resume inventory (work must survive)', run: () => pauseResume('inventory') },
  { at: 0.46, name: 'reload the page while the Review tab is open', run: () => withHands(reloadMidReview) },
  { at: 0.55, name: 'kill notes (crash) then resume it', run: () => crashResume('notes') },
  { at: 0.72, name: 'restart tend again', run: restartTend },
];
let restarting = false;
async function restartTend() {
  restarting = true;
  await srv.close();
  await sleep(3000);
  srv = await boot();
  metrics.restarts++;
  restarting = false;
  await sleep(1500);
  // the page must recover on its own (SSE reconnects); a reload is what a person would do if it didn't
  const ok = await page.until(`return document.querySelectorAll('#list [data-id]').length >= 3`, 'list after restart', 20_000).then(() => true, () => false);
  if (!ok) {
    find('restart', 'the page did not recover by itself after a restart; reloading');
    await openApp();
  }
  const list = await sessions();
  for (const p of plan) {
    const v = list.find((x) => x.id === p.id);
    if (v && v.state.status === 'ended' && !v.paused && p.name !== 'notes') find('restart', 'a running session came back as ended', p.name);
  }
}
async function reloadMidReview() {
  const p = plan[0];
  await selectInBrowser(p.id);
  await page.click('.dtabs button', 'Review');
  await sleep(2000);
  doing = 'reloading the page';
  await openApp();
  // after a reload the list opens on "For you" when something waits: count every session instead
  await page.until(`return Number(document.getElementById('cAll')?.textContent) >= 3`, 'sessions after reload', 15_000);
  await selectInBrowser(p.id);
  // the terminal must be live again: it shows Claude's screen
  const ok = await page.until(`return [...document.querySelectorAll('#termHost .xterm-rows > div')].some((d) => d.textContent.trim().length > 0)`, 'terminal after reload', 15_000).then(() => true, () => false);
  if (!ok) find('reload', 'after a reload the terminal stayed empty', p.name);
  doing = 'idle';
}

/** @param {string} name */
async function pauseResume(name) {
  const p = /** @type {P} */ (plan.find((x) => x.name === name));
  p.hold = true; // no new turns while we wait for a quiet moment
  for (let i = 0; i < 40; i++) {
    const v = (await sessions()).find((x) => x.id === p.id);
    if (v.state.status === 'idle' && !v.decisions?.length) break;
    await sleep(3000);
  }
  const before = (await sessions()).find((x) => x.id === p.id);
  const wt = before.workspace.worktree;
  const hash = treeHash(wt);
  await withHands(async () => {
    await selectInBrowser(p.id);
    await page.click('#dh [data-act="pause"]');
    await page.until(`return document.getElementById('dh').textContent.includes('Paused')`, 'paused', 30_000);
  });
  if (existsSync(wt)) find('pause', 'worktree still there after pause', name);
  await sleep(45_000);
  await withHands(async () => {
    await selectInBrowser(p.id); // the person comes back to this session
    await page.until(`return document.querySelector('#dh [data-act="resume"]') !== null`, 'resume button', 10_000);
    await page.click('#dh [data-act="resume"]');
    await page.until(`return !document.getElementById('dh').textContent.includes('Paused')`, 'resumed', 30_000).catch(async () => {
      find('resume', `resume did not finish: ${await page.js(`return document.getElementById('termNote').textContent`)}`, name);
    });
  });
  await sleep(8000);
  await acceptTrustIfShown(p);
  const after = treeHash(wt);
  if (after !== hash) find('resume', `files changed across pause/resume (${hash} → ${after})`, name);
  p.hold = false;
}
/** @param {string} name */
async function crashResume(name) {
  const p = /** @type {P} */ (plan.find((x) => x.name === name));
  p.hold = true;
  execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-session', '-t', `=tend-${p.id}`]);
  const crashed = await page.until(`return document.getElementById('list').textContent.includes('Ended unexpectedly')`, 'crashed', 15_000).then(() => true, () => false);
  if (!crashed) {
    const v = (await sessions()).find((x) => x.id === p.id);
    find('crash', `a killed session was not flagged as crashed (server: ${v?.state.status}, crashed ${v?.crashed})`, name);
  }
  await withHands(async () => {
    await selectInBrowser(p.id);
    await page.click('#dh [data-act="resume"]');
  });
  await sleep(10_000);
  await acceptTrustIfShown(p);
  // the conversation must continue: ask about something from before the crash
  const v = (await sessions()).find((x) => x.id === p.id);
  if (v.state.status === 'ended') find('crash', 'resume after the crash did not start Claude', name);
  p.turn = Math.max(p.turn, TASKS[name].length); // continue with a memory check
  TASKS[name].push({ text: 'What colour was the image I attached at the start? One word.' });
  p.turn = TASKS[name].length - 1;
  p.hold = false;
}

// ---- main loop ---------------------------------------------------------------------
let nextOracle = Date.now() + 15_000;
/** @type {Promise<void>} */
let chaosRunning = Promise.resolve();
let chaosBusy = false;
let chaosIdx = 0;
let busy = false;
try {
  while (Date.now() < END) {
    const list = restarting ? [] : await sessions().catch(() => []);
    for (const p of plan) {
      const v = list.find((x) => x.id === p.id);
      if (!v || v.paused || v.state.status === 'ended' || p.hold) continue;
      if (v.state.need === 'trust' || (v.state.status === 'starting' && Date.now() - v.createdAt > 5000)) await acceptTrustIfShown(p);
      for (const d of v.decisions ?? []) void answer(p, d);
      // waiting in the terminal with no card (its card was lost in a restart): the page says so; answer it there
      if (v.state.status === 'needs_you' && !v.decisions?.length && v.state.need !== 'trust' && Date.now() - v.state.since > 20_000 && !answering.has(`term-${p.id}`)) {
        answering.add(`term-${p.id}`);
        void withHands(async () => {
          await selectInBrowser(p.id);
          const hint = await page.until(`return /waiting for you in the terminal/i.test(document.getElementById('decision').textContent)`, 'terminal hint', 5000).then(() => true, () => false);
          if (!hint) find('card', 'needs you with no card, and the page did not say to answer in the terminal', p.name);
          if (DIALOG.test(lastLines(await screenOf(p.id)))) {
            await keys(p.id, '\r'); // Claude's own dialog: the highlighted "Yes"
            metrics.cards.terminal++;
            mark(`${p.name}: answered a card-less dialog in the terminal`);
          }
        }).finally(() => setTimeout(() => answering.delete(`term-${p.id}`), 15_000));
      }
      // the next turn: Claude is idle, nothing waiting, and our last turn had time to start
      if (!busy && v.state.status === 'idle' && !v.decisions?.length && Date.now() - p.sentAt > 8000) {
        busy = true;
        await sleep(rnd(1000, 6000));
        // half the time, look at what Claude changed first (which may send a review instead of the next turn)
        if (Math.random() < 0.5 && !restarting) await withHands(() => reviewSession(p)).catch((e) => find('review', `reviewing failed: ${e instanceof Error ? e.message : e}`, p.name));
        if (Date.now() - p.sentAt > 8000) await withHands(() => sendTurn(p)).catch((e) => find('turn', `could not send a turn: ${e instanceof Error ? e.message : e}`, p.name));
        busy = false;
      }
    }
    if (Date.now() >= nextOracle && !restarting) {
      nextOracle = Date.now() + 15_000;
      await oracle().catch((e) => find('oracle', String(e)));
      await uiOracle().catch((e) => find('ui-oracle', String(e)));
    }
    const due = chaos[chaosIdx];
    if (due && !chaosBusy && Date.now() - START >= due.at * MINUTES * 60_000) {
      chaosBusy = true;
      chaosIdx++;
      mark(`CHAOS: ${due.name}`);
      // alongside the loop: cards keep getting answered and other sessions keep working meanwhile
      chaosRunning = due.run().then(
        () => mark(`chaos done: ${due.name}`),
        (e) => find('chaos', `${due.name}: ${e instanceof Error ? e.message : e}`),
      ).finally(() => {
        chaosBusy = false; // one failure at a time
      });
    }
    await sleep(1000);
  }
  await chaosRunning;
  // ---- final checks -----------------------------------------------------------------
  const list = await sessions();
  const usage = /** @type {any} */ (await api('/api/usage')).accounts;
  for (const p of plan) {
    const v = list.find((x) => x.id === p.id);
    if (!v?.context) find('usage', 'no context from the status line', p.name);
  }
  if (!usage.some((/** @type {any} */ a) => a.fiveHour)) find('usage', 'no 5-hour usage seen for the account');
  const slugs = list.find((x) => x.name === 'slugs');
  const kebab = list.find((x) => x.name === 'kebab');
  if (slugs?.git?.changed.includes('src/soak/text.ts') && kebab?.git?.changed.includes('src/soak/text.ts') && !slugs.overlap) find('overlap', 'both sessions changed src/soak/text.ts but no overlap was flagged');
  if (page.errors.length) find('page', `${page.errors.length} page errors: ${page.errors.slice(0, 3).join(' | ')}`);
} catch (e) {
  find('abort', e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  const pct = (/** @type {number[]} */ xs, /** @type {number} */ q) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1) : 0;
  };
  const report = {
    minutes: MINUTES, sessions: plan.map((p) => ({ name: p.name, turns: p.turn })), ...metrics,
    ui: { ...metrics.ui, ping: { p50: pct(metrics.ui.ping, 0.5), p95: pct(metrics.ui.ping, 0.95), max: Math.round(Math.max(0, ...metrics.ui.ping)) }, reviewRender: { p50: pct(metrics.ui.reviewRender, 0.5), p95: pct(metrics.ui.reviewRender, 0.95) } },
    api: { p50: pct(metrics.api, 0.5), p95: pct(metrics.api, 0.95) }, keys: { p50: pct(metrics.keys, 0.5), p95: pct(metrics.keys, 0.95) },
    rss: { start: Math.round(metrics.rss[0] ?? 0), end: Math.round(metrics.rss.at(-1) ?? 0), max: Math.round(Math.max(0, ...metrics.rss)) },
    notifications: existsSync(join(home, 'notify.jsonl')) ? readFileSync(join(home, 'notify.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0,
    findings, timeline,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'soak.json'), JSON.stringify(report, null, 2));
  log(`done: ${metrics.turns} turns, ${findings.length} findings; report in ${join(OUT, 'soak.json')}`);
  browser.close();
  await srv.close().catch(() => undefined);
  try {
    execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // none
  }
  rmSync(join('/private/tmp', `tmux-${userInfo().uid}`, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
  process.exit(findings.length ? 1 : 0);
}
