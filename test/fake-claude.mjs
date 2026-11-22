#!/usr/bin/env node
// Fake `claude` for tests: replays real (sanitised) hook bodies from phase-0 fixtures.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const FIX = new URL('./fixtures/phase0/', import.meta.url);
/** @param {string} name */
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.312'} (Claude Code)\n`);
  process.exit(0);
}
if (argv[0] === 'agents' && argv[1] === '--json') {
  // sessions "running elsewhere": <CLAUDE_CONFIG_DIR>/agents.json, written by tests (never the real ~/.claude)
  const f = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'agents.json') : '';
  process.stdout.write(f && existsSync(f) ? readFileSync(f, 'utf8') : '[]\n');
  process.exit(0);
}
const sIdx = argv.indexOf('--settings');
if (sIdx < 0 || !argv[sIdx + 1]) {
  process.stderr.write('fake-claude: --settings <file> required\n');
  process.exit(2);
}
const settings = JSON.parse(readFileSync(argv[sIdx + 1], 'utf8'));
// tests read back exactly what tmux launched us with
writeFileSync(join(dirname(argv[sIdx + 1]), 'argv.json'), JSON.stringify(argv));
writeFileSync(join(dirname(argv[sIdx + 1]), 'env.json'), JSON.stringify({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null }));
const hook = settings.hooks.UserPromptSubmit[0].hooks[0];
/**
 * Real Claude runs the statusLine command on each update with the session JSON on stdin and shows its output.
 * `status [pct] [fivehour%]` sends the sanitised 2.1.312 fixture, optionally with other percentages.
 * @param {Record<string, unknown>} [patch]
 */
function statusLine(patch = {}) {
  const sl = settings.statusLine;
  if (!sl || sl.type !== 'command') return Promise.resolve('');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/status/010-statusline.json', import.meta.url), 'utf8'));
  // like real Claude, the cache expires an hour from now (the recorded time is in the past by now)
  fx.prompt_cache = { ...fx.prompt_cache, expires_at: Math.floor(Date.now() / 1000) + 3600 };
  const body = { ...fx, session_id: sessionId, cwd: process.cwd(), ...patch };
  return new Promise((resolveOut) => {
    const c = spawn('sh', ['-c', sl.command], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('error', () => resolveOut(''));
    c.on('close', () => resolveOut(out));
    c.stdin.on('error', () => undefined);
    c.stdin.end(JSON.stringify(body));
  });
}
/** Real Claude runs SessionStart as a command hook only, with the event JSON on stdin. */
function sessionStart() {
  for (const h of settings.hooks.SessionStart?.[0]?.hooks ?? []) {
    if (h.type !== 'command') continue;
    const c = spawn('sh', ['-c', h.command], { stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('error', () => undefined);
    c.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId, source: resume ? 'resume' : 'startup', cwd: process.cwd() }));
  }
}

// Claude's session id: chosen by tend (--session-id) or reused (--resume). Transcript checks only
// run when CLAUDE_CONFIG_DIR is set, so a test never touches the real ~/.claude.
const configDir = process.env.CLAUDE_CONFIG_DIR;
/** A flag's value in either the `--x=v` or the `--x v` form. */
const flagged = (/** @type {string} */ f) => {
  const eq = argv.find((a) => a.startsWith(`${f}=`));
  if (eq !== undefined) return eq.slice(f.length + 1);
  return argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : undefined;
};
const sid = flagged('--session-id');
const resume = flagged('--resume');
const sessionId = sid ?? resume ?? randomUUID();

/** @param {string} id */
function transcriptExists(id) {
  if (!configDir) return false;
  const projects = join(configDir, 'projects');
  try {
    return readdirSync(projects).some((d) => existsSync(join(projects, d, `${id}.jsonl`)));
  } catch {
    return false;
  }
}
if (configDir && sid && transcriptExists(sid)) {
  process.stdout.write(`Error: Session ID ${sid} is already in use.\n`);
  process.exit(1);
}
if (configDir && resume && !transcriptExists(resume)) {
  process.stdout.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}
let transcriptWritten = false;
function writeTranscript() {
  if (!configDir || transcriptWritten) return;
  transcriptWritten = true;
  const dir = join(configDir, 'projects', '-fake');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n', { flag: 'a' });
}

/** @param {string} s */
const write = (s) => process.stdout.write(s.replace(/\r?\n/g, '\r\n'));

function prompt() {
  write('╭──────────────────────────────╮\n│ ❯ \n╰──────────────────────────────╯\n  fake claude\n');
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} [patch]
 */
async function send(name, patch) {
  const body = { ...fixture(name), session_id: sessionId, ...patch };
  try {
    await fetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...hook.headers },
      body: JSON.stringify(body),
    });
  } catch {
    // server unreachable: keep going
  }
}

// Held PermissionRequests (like real Claude: the dialog stays usable while the hook is pending).
// Each answer is appended to <settings dir>/answers.jsonl as { tag, answer } for tests to check.
/** @type {Set<AbortController>} */
const inflight = new Set();
const answersFile = join(dirname(argv[sIdx + 1]), 'answers.jsonl');
/**
 * @param {string} name fixture
 * @param {Record<string, unknown>} patch
 * @param {string} tag
 */
function ask(name, patch, tag) {
  const ac = new AbortController();
  inflight.add(ac);
  fetch(hook.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...hook.headers },
    body: JSON.stringify({ ...fixture(name), session_id: sessionId, ...patch }),
    signal: ac.signal,
  })
    .then((r) => r.text())
    .then((t) => {
      const answer = t ? JSON.parse(t) : {};
      writeFileSync(answersFile, JSON.stringify({ tag, answer }) + '\n', { flag: 'a' });
      const d = answer.hookSpecificOutput?.decision;
      write(d ? `Tend answered ${tag}: ${d.behavior}${d.message ? ` (${d.message})` : ''}\n` : `no hook answer for ${tag}: dialog decides\n`);
    })
    .catch(() => undefined) // aborted: answered in the terminal
    .finally(() => inflight.delete(ac));
}

// like real Claude, the 5-hour reset time is stable for the whole run
const RESETS_AT = Math.floor(Date.now() / 1000) + 3600;

/** @param {string} line */
async function handle(line) {
  const cmd = line.trim();
  if (trusting && cmd !== 'trust') {
    trusting = false;
    write('\x1b[2J\x1b[H');
    prompt();
    return;
  }
  writeTranscript();
  switch (cmd) {
    case 'perm':
      ask('005-PermissionRequest.json', {}, 'perm');
      await send('006-Notification.json');
      write('Do you want to create test.txt?\n❯ 1. Yes\n  2. Yes, allow all edits during this session\n  3. No, and tell Claude what to do differently\n');
      break;
    case 'ok':
      await send('007-PostToolUse.json');
      await send('009-Stop.json');
      await send('011-SubagentStop.json');
      prompt();
      break;
    case 'ask':
      ask('023-PermissionRequest.json', {}, 'ask');
      break;
    case 'plan':
      ask('114-PermissionRequest.json', {}, 'plan');
      break;
    case 'tui': // the user answers in Claude's own dialog (Phase 0: Claude closed the held request)
      for (const ac of inflight) ac.abort();
      write('Answered in the terminal\n');
      break;
    case 'tui-open': // 2.1.312: answered in the dialog, the held request stays open; the tool runs, the turn ends
      await send('007-PostToolUse.json', { tool_name: 'Write', tool_input: fixture('005-PermissionRequest.json').tool_input });
      await send('009-Stop.json');
      write('Answered in the terminal (request left open)\n');
      break;
    case 'trust':
      write(
        // the layout real Claude Code 2.1.312 draws (captured 2026-10-28)
        'Accessing workspace:\n\n' + process.cwd() + '\n\n' +
          "Quick safety check: Is this a project you created or one you trust?\n\n" +
          '❯ No, exit\n  Yes, I trust this folder\n\nEnter to confirm · Esc to cancel\n',
      );
      break;
    case 'cls':
      write('\x1b[2J\x1b[H');
      prompt();
      break;
    case 'statusline': {
      const out = await statusLine();
      write(`status line: ${out.trim()}\n`);
      break;
    }
    case 'exit': // like /exit in real 2.1.312 (the fixture was recorded from a killed session: reason "other")
      await send('130-SessionEnd.json', { reason: 'prompt_input_exit' });
      process.exit(0);
      break;
    default:
      if (cmd.startsWith('status ')) {
        // `status <context %> <5-hour %>`: a status update with other values
        const [ctx, five] = cmd.slice(7).split(/\s+/).map(Number);
        const base = JSON.parse(readFileSync(new URL('./fixtures/status/010-statusline.json', import.meta.url), 'utf8'));
        await statusLine({
          context_window: { ...base.context_window, used_percentage: ctx, total_input_tokens: (ctx ?? 0) * 10000 },
          rate_limits: { ...base.rate_limits, five_hour: { used_percentage: five ?? 10, resets_at: RESETS_AT } },
        });
        break;
      }
      if (cmd.startsWith('bash ')) {
        // a Bash permission request tagged with its own command: `bash <command>`
        const command = cmd.slice(5);
        ask('005-PermissionRequest.json', { tool_name: 'Bash', tool_input: { command, description: 'fake' }, permission_suggestions: [] }, command);
        break;
      }
      if (cmd.startsWith('edit ')) {
        const abs = resolve(process.cwd(), cmd.slice(5).trim());
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, 'x\n');
        await send('004-PreToolUse.json', { tool_name: 'Write' });
        await send('007-PostToolUse.json', {
          tool_name: 'Write', tool_input: { file_path: abs, content: 'x\n' }, cwd: process.cwd(),
        });
        await send('009-Stop.json');
        prompt();
        break;
      }
      await send('002-UserPromptSubmit.json');
      await send('004-PreToolUse.json', { tool_name: 'Bash' });
      await send('007-PostToolUse.json');
      await send('009-Stop.json');
      prompt();
  }
}

// `-p <prompt>`: non-interactive, like the self-test uses: the hook sequence for one permissioned Bash call
if (argv.includes('-p')) {
  const prompt = argv[argv.indexOf('-p') + 1] ?? '';
  sessionStart();
  await new Promise((r) => setTimeout(r, 200));
  await send('002-UserPromptSubmit.json', { prompt });
  const cmd = /mkdir (\S+)/.exec(prompt)?.[1];
  const input = { command: `mkdir ${cmd ?? 'x'}`, description: 'self-test' };
  await send('004-PreToolUse.json', { tool_name: 'Bash', tool_input: input });
  const answer = process.env.FAKE_SKIP_PERMISSION ? null : await fetch(hook.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...hook.headers },
    body: JSON.stringify({ ...fixture('005-PermissionRequest.json'), session_id: sessionId, tool_name: 'Bash', tool_input: input }),
  }).then((r) => r.json()).catch(() => null);
  if (answer?.hookSpecificOutput?.decision?.behavior === 'allow' && cmd) {
    mkdirSync(resolve(process.cwd(), cmd), { recursive: true });
    await send('007-PostToolUse.json', { tool_name: 'Bash', tool_input: input });
  }
  await send('009-Stop.json');
  process.stdout.write('done\n');
  process.exit(0);
}

// `--fake-trust`: start on the trust dialog like real Claude in an unknown folder (no SessionStart
// yet); the next line accepts it and shows the prompt, still without SessionStart (2.1.312 sends none).
let trusting = argv.includes('--fake-trust');
if (trusting) handle('trust');
else {
  prompt();
  sessionStart();
}
// serialize handling so hook order is preserved across queued lines
let chain = Promise.resolve();
if (process.stdin.isTTY) {
  // like real Claude: raw keys, bracketed paste on (a paste arrives between ESC[200~ and ESC[201~), our own echo
  process.stdin.setRawMode(true);
  process.stdout.write('\x1b[?2004h');
  let line = '';
  process.stdin.on('data', (chunk) => {
    const text = chunk.toString('utf8').replace(/\x1b\[20[01]~/g, '');
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        const l = line;
        line = '';
        process.stdout.write('\r\n');
        chain = chain.then(() => handle(l));
      } else if (ch === '\x7f' || ch === '\b') {
        if (line) {
          line = line.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (ch === '\x03' || ch === '\x04') {
        chain.then(() => process.exit(0));
      } else if (ch >= ' ' || ch === '\t') {
        line += ch;
        process.stdout.write(ch);
      }
    }
  });
  process.stdin.on('end', () => {
    chain.then(() => process.exit(0));
  });
} else {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (l) => { chain = chain.then(() => handle(l)); });
  rl.on('close', () => { chain.then(() => process.exit(0)); });
}
