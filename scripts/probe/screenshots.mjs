#!/usr/bin/env node
// Headless screenshots of the UI against a real server driving fake claude.
// Usage: node scripts/probe/screenshots.mjs   →   docs/versions/v0.3/shots/<theme>-<width>-<scene>.png
// Everything lives in temp dirs: TEND_HOME, CLAUDE_CONFIG_DIR, the git repos and a unique tmux socket.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'docs', 'versions', 'v0.7', 'shots');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZES = [[1720, 1000], [1280, 800]];

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Async on purpose: the server runs in this process and must keep answering while Chrome loads.
 * @param {string} url @param {string} file @param {number[]} size
 */
function shoot(url, file, [w, h]) {
  const profile = mkdtempSync(join(tmpdir(), 'tend-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    `--screenshot=${file}`,
    `--window-size=${w},${h}`,
    '--virtual-time-budget=4000',
    url,
  ];
  return new Promise((resolve, reject) => {
    execFile(CHROME, args, { timeout: 60_000 }, (err) => {
      rmSync(profile, { recursive: true, force: true });
      if (err) reject(err);
      else resolve(file);
    });
  });
}

/** @param {string} dir @param {...string} args */
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A temp repo with one commit and a local identity. @param {string} dir */
function makeRepo(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Tend Shots');
  git(dir, 'config', 'user.email', 'shots@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'tend-shots-')));
  const socket = `tend-test-shots-${randomBytes(4).toString('hex')}`;
  // set before the server modules load: the launcher reads them from process.env
  process.env.TEND_CLAUDE_BIN = join(ROOT, 'test', 'fake-claude.mjs');
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tend-shots-claude-'));
  const { startServer } = await import('../../src/server.ts');
  const { loadOrCreateToken } = await import('../../src/config.ts');
  const port = await freePort();
  const token = loadOrCreateToken(home);
  const srv = await startServer({ home, port, token, tmuxSocket: socket, notifyMode: 'off', watchIntervalMs: 500 });
  const base = `http://127.0.0.1:${port}`;

  /** @param {string} method @param {string} path @param {unknown} [body] @param {Record<string, string>} [headers] */
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'x-tend-token': token, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };
  const code = join(home, 'code');
  const webApp = makeRepo(join(code, 'web-app'));
  const apiServer = makeRepo(join(code, 'api-server'));
  const docsSite = makeRepo(join(code, 'docs-site'));
  const newClient = makeRepo(join(code, 'new-client'));

  /** @param {string} cwd @param {string} name @param {boolean} [isolate] @returns {Promise<any>} */
  const mk = (cwd, name, isolate = true) => call('POST', '/api/sessions', { cwd, name, isolate });
  /** @param {string} id @param {string} line */
  const type = (id, line) => fetch(`${base}/api/sessions/${id}/keys`, { method: 'POST', headers: { 'x-tend-token': token }, body: `${line}\r` });
  /** Hooks carry the launch nonce from the session's generated settings, like real Claude's would. @param {string} id @param {Record<string, unknown>} body */
  const hook = (id, body) => {
    const s = JSON.parse(readFileSync(join(home, 'sessions', id, 'settings.json'), 'utf8'));
    const launch = s.hooks.Stop[0].hooks[0].headers['x-tend-launch'];
    return call('POST', '/hook', body, { 'x-tend-session': id, 'x-tend-launch': launch });
  };
  /** @param {string} id @returns {Promise<any>} */
  const view = async (id) => (await call('GET', '/api/sessions')).find((/** @type {any} */ s) => s.id === id);
  /** Poll the API until `ok(view)` holds. @param {string} id @param {(v: any) => boolean} ok @param {string} what */
  const until = async (id, ok, what) => {
    for (let i = 0; i < 150; i++) {
      const v = await view(id);
      if (v && ok(v)) return v;
      await sleep(100);
    }
    throw new Error(`session ${id} never reached: ${what}`);
  };
  /** Write a file in a session's folder and report it the way Claude's hooks would. @param {any} v @param {string} rel @param {string} message */
  const edit = async (v, rel, message) => {
    const dir = v.workspace.mode === 'worktree' ? v.workspace.worktree : v.cwd;
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `// ${rel}\nexport {};\n`);
    await hook(v.id, { hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    await hook(v.id, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } });
    await hook(v.id, { hook_event_name: 'Stop', last_assistant_message: message });
  };
  /** @param {string} id @param {string} prompt */
  const ask = (id, prompt) => hook(id, { hook_event_name: 'UserPromptSubmit', prompt });

  const url = (/** @type {string} */ q) => `${base}/?key=${token}&snap${q}`;
  /** @type {string[]} */
  const shots = [];
  try {
    const checkout = await mk(webApp, 'checkout-flow');
    const a11y = await mk(webApp, 'a11y-pass');
    const dark = await mk(webApp, 'dark-mode');
    const search = await mk(webApp, 'search-index');
    const auth = await mk(apiServer, 'auth-refresh');
    const limits = await mk(apiServer, 'rate-limits');
    const changelog = await mk(docsSite, 'changelog', false);
    process.env.TEND_CLAUDE_ARGS = '--fake-trust'; // this one starts on Claude's trust dialog
    const onboarding = await mk(newClient, 'onboarding', false);
    delete process.env.TEND_CLAUDE_ARGS;
    const deploy = await mk(apiServer, 'deploy-fix');
    const colours = await mk(docsSite, 'theme-picker', false);
    const planner = await mk(newClient, 'billing-plan', false);
    await sleep(1500); // let fake claude draw its prompt

    // (5) Claude's trust dialog, shown before any hook
    await until(onboarding.id, (v) => v.state.need === 'trust', 'needs_you/trust');

    // (1) a filled briefing and live git facts
    await ask(checkout.id, 'Add an address step to checkout, with postcode validation for UK and DE.');
    await edit(checkout, 'src/checkout/address.ts', 'Added the address step and wired it between cart and payment.');
    git(checkout.workspace.worktree, 'add', '-A');
    git(checkout.workspace.worktree, 'commit', '-q', '-m', 'checkout: address step');
    await ask(checkout.id, 'Use the shared validator instead of a regex per country.');
    await edit(checkout, 'src/checkout/postcode.ts', 'Postcode checks now go through validate(); UK and DE cases pass.');
    await ask(checkout.id, 'Show the error under the field, not in a toast.');
    await edit(checkout, 'src/app.ts', 'Errors render inline below each field.');
    await until(checkout.id, (v) => v.git?.commits === 1 && v.git?.uncommitted >= 2, 'checkout git facts');

    // (2) an overlap pair
    await ask(a11y.id, 'Fix the colour-contrast issues the audit found.');
    await edit(a11y, 'src/shared.ts', 'Raised contrast on muted text tokens.');
    await ask(dark.id, 'Add a dark theme.');
    await edit(dark, 'src/shared.ts', 'Added dark tokens next to the light ones.');
    await until(a11y.id, (v) => v.overlap?.with.includes(dark.id), 'overlap');
    await until(dark.id, (v) => v.overlap?.with.includes(a11y.id), 'overlap');

    // (3) a paused session
    await ask(search.id, 'Rebuild the search index on deploy.');
    await edit(search, 'src/search/index.ts', 'The index now rebuilds in the deploy hook.');
    await until(search.id, (v) => v.git?.uncommitted >= 1, 'search git facts');
    await call('POST', `/api/sessions/${search.id}/pause`);
    await until(search.id, (v) => v.paused, 'paused');

    // (6) decision cards: a medium-risk permission, a high-risk one, a question and a plan
    await type(auth.id, 'bash npm install jose@5');
    await until(auth.id, (v) => v.decisions?.length === 1, 'permission card');
    await type(deploy.id, 'bash git push --force origin main');
    await until(deploy.id, (v) => v.decisions?.length === 1, 'high-risk card');
    await type(colours.id, 'ask');
    await until(colours.id, (v) => v.decisions?.length === 1, 'question card');
    await type(planner.id, 'plan');
    await until(planner.id, (v) => v.decisions?.length === 1, 'plan card');
    // (7) context and usage from the status line: rings at 72% and 91%, usage for the popover
    await type(checkout.id, 'status 72 61');
    await type(deploy.id, 'status 91 63');
    await type(changelog.id, 'status 20 64');
    await sleep(600);
    await type(checkout.id, 'status 74 64');
    await until(checkout.id, (v) => v.context?.pct === 74, 'context');
    // (8) calm: a stuck session (the same failure 3×) and one that crashed; held notifications come by default
    const lint = await mk(apiServer, 'lint-fix');
    const worker = await mk(webApp, 'queue-worker');
    await sleep(800);
    for (let i = 0; i < 3; i++) await hook(lint.id, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'npm ERR! Missing script: "lint"', is_interrupt: false });
    await until(lint.id, (v) => v.stuck, 'stuck');
    execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-session', '-t', `=tend-${worker.id}`]);
    await until(worker.id, (v) => v.crashed, 'crashed');
    // (9) media: two attachments on checkout-flow (the Files panel shows its changed files)
    const { deflateSync, crc32 } = await import('node:zlib');
    const swatch = (/** @type {number[]} */ rgb) => {
      const chunk = (/** @type {string} */ t, /** @type {Buffer} */ d) => {
        const head = Buffer.alloc(4);
        head.writeUInt32BE(d.length);
        const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(td) >>> 0);
        return Buffer.concat([head, td, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(48, 0);
      ihdr.writeUInt32BE(32, 4);
      ihdr[8] = 8;
      ihdr[9] = 2;
      const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 48 }, () => rgb).flat())]);
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 32 }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
    };
    for (const [name, rgb] of /** @type {[string, number[]][]} */ ([['login-error.png', [200, 60, 60]], ['figma-checkout.png', [70, 110, 220]]])) {
      await fetch(`${base}/api/sessions/${checkout.id}/attachments`, { method: 'POST', headers: { 'x-tend-token': token, 'x-file-name': name }, body: swatch(rgb) });
    }
    // the rest of the fleet: one working, one idle in place
    await ask(limits.id, 'Add per-token rate limits.');
    await hook(limits.id, { hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    await until(limits.id, (v) => v.state.status === 'working', 'working');
    await ask(changelog.id, 'Tidy the changelog for 2.4.');
    await edit(changelog, 'CHANGELOG.md', 'Grouped 2.4 entries by area and fixed two broken links.');
    await until(changelog.id, (v) => v.state.status === 'idle', 'idle');
    await sleep(800);

    const scenes = [
      ['briefing', `&tab=all&s=${checkout.id}`],
      ['overlap', `&tab=you&s=${a11y.id}`],
      ['paused', `&tab=all&s=${search.id}`],
      ['new-session', `&tab=all&s=${checkout.id}&new=~/code/web-app`],
      ['trust', `&tab=you&s=${onboarding.id}`],
      ['permission', `&tab=you&s=${auth.id}`],
      ['high-risk', `&tab=you&s=${deploy.id}`],
      ['question', `&tab=you&s=${colours.id}`],
      ['plan', `&tab=you&s=${planner.id}`],
      ['usage', `&tab=all&s=${checkout.id}&usage`],
      ['stuck', `&tab=you&s=${lint.id}`],
      ['crashed', `&tab=you&s=${worker.id}`],
      ['today', `&tab=you&s=${checkout.id}&today`],
      ['pace', `&tab=you&s=${checkout.id}&pace`],
      ['attachments', `&tab=all&s=${checkout.id}`],
      ['files', `&tab=all&s=${checkout.id}&files`],
      ['palette', `&tab=all&s=${checkout.id}&palette`],
    ];
    for (const size of SIZES) {
      for (const theme of ['dark', 'light']) {
        for (const [scene, q] of scenes) {
          shots.push(await shoot(url(`${q}&theme=${theme}`), join(OUT, `${theme}-${size[0]}-${scene}.png`), size));
        }
      }
    }
  } finally {
    await srv.close();
    try {
      execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
    rmSync(join('/private/tmp', `tmux-${userInfo().uid}`, socket), { force: true }); // kill-server leaves the socket file
    rmSync(home, { recursive: true, force: true });
    rmSync(/** @type {string} */ (process.env.CLAUDE_CONFIG_DIR), { recursive: true, force: true });
  }
  for (const s of shots) console.log(s);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
