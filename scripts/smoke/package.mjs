#!/usr/bin/env node
// Packaging smoke (v1.0): npm pack → install the tarball into an empty folder → run the installed `tend` (compiled
// dist, from node_modules) with a stand-in claude → the page, vendor files, a session and its status line wrapper
// all work. Nothing is published. Always cleans up; exits non-zero on failure.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'tend-pkg-'));
const home = mkdtempSync(join(tmpdir(), 'tend-pkg-home-'));
const socket = `tend-pkg-${process.pid}`;
const log = (/** @type {string} */ m) => process.stdout.write(`[package] ${m}\n`);
let failure = '';
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {{ port: number }} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});
try {
  const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: root, encoding: 'utf8' }).trim().split('\n').pop() ?? '';
  log(`packed ${tgz}`);
  const listed = execFileSync('tar', ['-tzf', join(work, tgz)], { encoding: 'utf8' });
  if (/package\/src\//.test(listed) || /package\/test\//.test(listed)) throw new Error('the package ships src/ or test/');
  for (const f of ['package/bin/tend.mjs', 'package/bin/tend-statusline.mjs', 'package/dist/src/server.js', 'package/dist/src/folder-panel.jxa', 'package/ui/index.html']) {
    if (!listed.includes(f)) throw new Error(`missing from the package: ${f}`);
  }
  const app = join(work, 'app');
  execFileSync('mkdir', ['-p', app]);
  writeFileSync(join(app, 'package.json'), '{"name":"try-tend","private":true}');
  execFileSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', '--silent', join(work, tgz)], { cwd: app, stdio: 'inherit' });
  log('installed into an empty folder');
  const stub = join(work, 'claude');
  writeFileSync(stub, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "2.1.312 (Claude Code)"; exit 0; }\nsleep 60\n');
  chmodSync(stub, 0o755);
  const port = await freePort();
  child = spawn(join(app, 'node_modules', '.bin', 'tend'), [], {
    env: { ...process.env, TEND_HOME: home, TEND_PORT: String(port), TEND_CLAUDE_BIN: stub, TEND_NOTIFY: 'off', TEND_TMUX_SOCKET: socket, TEND_ACCOUNTS: ':' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr?.on('data', (d) => (err += d));
  const line = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error(`no start line: ${out} ${err}`)), 20_000);
    child?.stdout?.on('data', (d) => {
      out += d;
      if (out.includes('\n')) {
        clearTimeout(t);
        resolve(out.split('\n')[0]);
      }
    });
  });
  const key = /key=([0-9a-f]{64})/.exec(String(line))?.[1];
  if (!key) throw new Error(`unexpected start line: ${line}`);
  log(String(line).replace(key, '…'));
  const base = `http://127.0.0.1:${port}`;
  const h = { 'x-tend-token': key };
  const ok = async (/** @type {string} */ path) => {
    const r = await fetch(base + path, { headers: h });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r;
  };
  await ok('/health');
  if (!(await (await ok('/')).text()).includes('tend')) throw new Error('the page did not load');
  await ok('/vendor/xterm.js');
  await ok('/ui/app.js');
  const s = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ cwd: work, name: 'pkg', isolate: false }) })).json();
  const settings = JSON.parse(readFileSync(join(home, 'sessions', s.id, 'settings.json'), 'utf8'));
  // sessions point at a stable shim in ~/.tend/bin, which runs the wrapper inside the installed package
  const shim = /'([^']*bin\/tend-statusline)'/.exec(settings.statusLine.command)?.[1];
  if (!shim || !existsSync(shim)) throw new Error(`no status line shim in the settings: ${settings.statusLine.command}`);
  const wrapper = /'([^']*tend-statusline\.mjs)'/.exec(readFileSync(shim, 'utf8'))?.[1];
  if (!wrapper || !wrapper.includes(join('node_modules', 'tend-cc', 'bin')) || !existsSync(wrapper)) throw new Error(`status line wrapper not in the installed package: ${wrapper}`);
  // the wrapper runs from node_modules (compiled dist) and posts to tend
  execFileSync(shim, [join(home, 'sessions', s.id, 'status.json')], { input: JSON.stringify({ context_window: { used_percentage: 12 } }), timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 300));
  const v = (await (await ok("/api/sessions")).json()).find((/** @type {{ id: string }} */ x) => x.id === s.id);
  if (v?.context?.pct !== 12) throw new Error('the installed status line wrapper did not report');
  log('page, vendor files, a session and the status line wrapper work from the installed package');
  log('PASS');
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[package] FAIL: ${failure}\n`);
} finally {
  child?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  try {
    execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // none
  }
  rmSync(join('/private/tmp', `tmux-${userInfo().uid}`, socket), { force: true });
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  for (const f of readdirSync(root)) if (/^tend-.*\.tgz$/.test(f)) rmSync(join(root, f));
}
process.exit(failure ? 1 : 0);
