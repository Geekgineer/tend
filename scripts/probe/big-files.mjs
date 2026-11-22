#!/usr/bin/env node
// Probe: does the Review tab stay responsive on big files? Fake claude, temp repo, real headless Chrome.
// Reports the longest main-thread block per file and view. Usage: node scripts/probe/big-files.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../lib/cdp.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'tend-probe-')));
const socket = `tend-probe-${process.pid}`;
process.env.TEND_CLAUDE_BIN = join(ROOT, 'test', 'fake-claude.mjs');
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tend-probe-claude-'));
process.env.TEND_ACCOUNTS = ':';
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {{ port: number }} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});

// a repo with the kinds of big files real projects have
const repo = join(home, 'big');
mkdirSync(join(repo, 'src'), { recursive: true });
const git = (/** @type {string[]} */ ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'P');
git('config', 'user.email', 'p@example.com');
const lock = { name: 'x', lockfileVersion: 3, packages: Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`node_modules/pkg-${i}`, { version: `1.${i}.0`, resolved: `https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.${i}.0.tgz`, integrity: `sha512-${'a'.repeat(86)}==`, dev: i % 2 === 0 }])) };
writeFileSync(join(repo, 'package-lock.json'), JSON.stringify(lock, null, 2));
const ts = Array.from({ length: 12000 }, (_, i) => `export function f${i}(a: number, b: string): string { return \`\${a}-\${b}\`; } // ${i}`).join('\n');
writeFileSync(join(repo, 'src', 'gen.ts'), ts);
const md = Array.from({ length: 1500 }, (_, i) => `## Section ${i}\n\nSome **text** with \`code\` and a [link](#section-${i}).\n\n- item a\n- item b\n\n\`\`\`ts\nconst x${i} = ${i};\n\`\`\`\n`).join('\n');
writeFileSync(join(repo, 'BIG.md'), md);
writeFileSync(join(repo, 'min.js'), 'var a=1;'.repeat(150_000)); // one 1.2 MB line
git('add', '-A');
git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');

const { startServer } = await import('../../src/server.ts');
const token = 'probe-' + Math.random().toString(36).slice(2);
const srv = await startServer({ home, port, token, tmuxSocket: socket, notifyMode: 'stub' });
const base = `http://127.0.0.1:${port}`;
const api = async (/** @type {string} */ p, /** @type {RequestInit} */ i = {}) => (await fetch(base + p, { ...i, headers: { 'x-tend-token': token, 'content-type': 'application/json', ...(i.headers ?? {}) } })).json();
const v = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd: repo, name: 'big' }) });
await sleep(1500);
const wt = v.workspace.worktree;
// Claude "changes" the big files too, so diffs and changed-block marks are exercised
writeFileSync(join(wt, 'src', 'gen.ts'), ts.replace(/\/\/ (\d*5)$/gm, '// changed $1'));
writeFileSync(join(wt, 'BIG.md'), md.replace(/item b/g, 'item B'));
writeFileSync(join(wt, 'package-lock.json'), JSON.stringify({ ...lock, lockfileVersion: 4 }, null, 2));
await sleep(12_000); // git facts

const browser = await openBrowser();
const page = await browser.page();
await page.navigate(`${base}/?key=${token}`);
await page.until(`return document.querySelector('.dtabs') !== null && document.querySelectorAll('#list [data-id]').length === 1`, 'app', 15_000);
await page.js(`window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); return true;`);
await page.click('.dtabs button', 'Review');
await page.until(`return document.querySelectorAll('.rvrow').length > 0`, 'tree', 15_000);

/** Open a file in a view; report the longest block and whether the page answered meanwhile. */
async function probe(/** @type {string} */ path, /** @type {string} */ mode) {
  await page.js(`window.__long = []; return true;`);
  const t0 = Date.now();
  await page.js(`document.querySelector('.rvfilter').value = ''; document.querySelector('.rvfilter').dispatchEvent(new Event('input'));
    const l = [...document.querySelectorAll('.rvseg, .rvtop .seg button')].find((b) => b.textContent.startsWith('All')); l?.click(); return true;`);
  await page.js(`[...document.querySelectorAll('.rvrow')].find((r) => r.dataset.path === ${JSON.stringify(path)})?.click(); return true;`);
  await sleep(300);
  if (mode) await page.js(`[...document.querySelectorAll('.rvmodes button')].find((b) => b.textContent === ${JSON.stringify(mode)})?.click(); return true;`);
  await page.until(`return document.querySelector('.rvcontent')?.textContent && !/^Loading/.test(document.querySelector('.rvcontent').textContent)`, `${path} ${mode}`, 60_000).catch(() => undefined);
  const ms = Date.now() - t0;
  const long = /** @type {number[]} */ (await page.js(`return window.__long`));
  const rows = await page.js(`return document.querySelectorAll('.rvcontent .rl, .rvcontent .rl2, .rvcontent .mdb').length`);
  console.log(`${path.padEnd(18)} ${(mode || 'default').padEnd(8)} shown in ${String(ms).padStart(6)} ms · longest block ${Math.round(Math.max(0, ...long))} ms · total blocked ${Math.round(long.reduce((a, b) => a + b, 0))} ms · ${rows} rows`);
}
for (const [p, m] of [['src/gen.ts', 'Diff'], ['src/gen.ts', 'Source'], ['BIG.md', 'Preview'], ['BIG.md', 'Diff'], ['package-lock.json', 'Diff'], ['package-lock.json', 'Source'], ['min.js', '']]) await probe(p, m);
// full-file diff
await page.js(`[...document.querySelectorAll('.rvrow')].find((r) => r.dataset.path === 'src/gen.ts')?.click(); return true;`);
await sleep(500);
await page.js(`window.__long = []; [...document.querySelectorAll('.rvbar button')].find((b) => b.textContent === 'Full file')?.click(); return true;`);
await sleep(8000);
console.log(`gen.ts full-file diff: longest block ${Math.round(Math.max(0, ...(/** @type {number[]} */ (await page.js('return window.__long')))))} ms`);
browser.close();
await srv.close();
try {
  execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
} catch {}
rmSync(home, { recursive: true, force: true });
process.exit(0);
