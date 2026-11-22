#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync, watchFile } from 'node:fs';
import { delimiter, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 24) {
  process.stderr.write(`tend needs Node.js 24 or newer (you have ${process.versions.node}).\nUpdate: https://nodejs.org  or  brew install node\n`);
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('-'));
const flag = (/** @type {string} */ f) => argv.includes(f);

/** @param {string} bin */
function onPath(bin) {
  const candidates = bin.includes('/') ? [bin] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, bin));
  return candidates.some((f) => {
    try {
      accessSync(f, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

if (flag('--version') || flag('-v')) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (flag('--help') || flag('-h') || command === 'help') {
  process.stdout.write(`tend ${pkg.version}: one calm page for every Claude Code session

Usage
  tend                 start, and open the page in your browser
  tend --no-open       start without opening the browser
  tend doctor          check that everything tend needs is installed
  tend rotate-token    make a new link (old links stop working)
  tend --version

Environment
  TEND_PORT            port to listen on (default 4977)
  TEND_HOME            where tend keeps its data (default ~/.tend)
  TEND_NO_OPEN=1       never open the browser
`);
  process.exit(0);
}
if (command === 'doctor') {
  const claude = process.env.TEND_CLAUDE_BIN || 'claude';
  const tmuxOk = onPath('tmux');
  const mac = process.platform === 'darwin';
  /** @type {[string, boolean, string][]} */
  const checks = [
    ['Node.js 24+', true, `v${process.versions.node}`],
    ['tmux', tmuxOk, tmuxOk ? 'installed' : 'brew install tmux'],
    ['Claude Code', onPath(claude), 'npm i -g @anthropic-ai/claude-code, then run claude once to log in'],
    ['macOS', mac, mac ? 'yes' : 'the core works on Linux; folder window, notifications and image conversion need macOS'],
  ];
  let version = '';
  if (checks[2][1]) {
    try {
      version = execFileSync(claude, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    } catch {
      // reported below as not working
    }
    checks[2] = ['Claude Code', version !== '', version || 'claude is on PATH but `claude --version` failed'];
  }
  for (const [name, ok, detail] of checks) process.stdout.write(`${ok ? '✓' : name === 'macOS' ? '!' : '✗'} ${name.padEnd(12)} ${ok ? detail : `→ ${detail}`}\n`);
  const blocking = checks.filter(([n, ok]) => !ok && n !== 'macOS');
  process.stdout.write(blocking.length ? `\nFix the ✗ items above, then run: tend\n` : `\nAll set. Run: tend\n`);
  process.exit(blocking.length ? 1 : 0);
}
if (command && command !== 'start' && command !== 'rotate-token') {
  process.stderr.write(`Unknown command: ${command}. Try: tend --help\n`);
  process.exit(1);
}

// A checkout runs src/*.ts directly; an installed copy (inside node_modules, where Node won't strip types) runs
// the compiled dist/src/*.js.
const here = import.meta.dirname;
const compiled = here.includes(`${sep}node_modules${sep}`) || !existsSync(join(here, '..', 'src', 'server.ts'));
/** @param {string} name */
const load = (name) => import(compiled ? `../dist/src/${name}.js` : `../src/${name}.ts`);
const { claudeBin } = await load('claude-launch');
const { confirmLock, loadOrCreateToken, lockOwnerAlive, port: configPort, readLock, removeLock, rotateToken, takeLock, tendHome } = await load('config');
const { notifyModeFromEnv } = await load('notifier');
const { startServer } = await load('server');
const { warmFolderPanel } = await load('choose-folder');
const { createTmux } = await load('tmux');

/** @param {string} msg */
function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const socket = process.env.TEND_TMUX_SOCKET || 'tend';
const port = configPort();
if (command === 'rotate-token') {
  // a new link; a running tend notices the token file change within a second; sessions keep their hooks
  const home = tendHome();
  const token = rotateToken(home);
  const lock = readLock(home);
  const livePort = lock && (await lockOwnerAlive(lock)) ? lock.port : port;
  process.stdout.write(`New link: http://127.0.0.1:${livePort}/?key=${token}\nOld links and open tabs need the new one.\n`);
  process.exit(0);
}

if (!createTmux(socket).available()) fail('tend needs tmux.\n  Install it: brew install tmux\n  Then run: tend   (or check everything with: tend doctor)');
if (!onPath(claudeBin())) fail('tend needs Claude Code.\n  Install it: npm i -g @anthropic-ai/claude-code\n  Run `claude` once to log in, then run: tend   (or: tend doctor)');

const home = tendHome();
const instance = randomBytes(8).toString('hex');
if (!(await takeLock(home, port, instance))) {
  const running = readLock(home);
  fail(`tend is already running at http://127.0.0.1:${running?.port ?? port}/ (pid ${running?.pid}).`);
}
const token = loadOrCreateToken(home);

/** @type {{ close(): Promise<void>, setToken(t: string): void }} */
let srv;
try {
  srv = await startServer({ home, port, token, tmuxSocket: socket, notifyMode: notifyModeFromEnv(), instance });
} catch (e) {
  removeLock(home, instance);
  if (e && typeof e === 'object' && 'code' in e && e.code === 'EADDRINUSE') fail(`Port ${port} is busy. Is tend already running?`);
  throw e;
}

// Stop the server only: tmux sessions (and the claude processes in them) keep running.
// Installed before the link is printed, so a stop right after start is still clean.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  removeLock(home, instance);
  srv.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop); // the terminal closed
confirmLock(home, port, instance); // serving now: the lock is ours
// `tend rotate-token` rewrites the token file; pick it up (and drop open streams) within a second
watchFile(join(home, 'token'), { interval: 1000 }, () => srv.setToken(loadOrCreateToken(home)));

warmFolderPanel(); // the New session folder window then opens at once
const link = `http://127.0.0.1:${port}/?key=${token}`;
process.stdout.write(`tend. running at ${link}\n`);
// open the page for people at a terminal; never in scripts, pipes or when asked not to
if (process.stdout.isTTY && !flag('--no-open') && !process.env.TEND_NO_OPEN && (process.platform === 'darwin' || process.platform === 'linux')) {
  try {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [link], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
    process.stdout.write('Opened it in your browser. Press Ctrl+C to stop tend; your sessions keep running.\n');
  } catch {
    // no browser opener: the link above is enough
  }
}

