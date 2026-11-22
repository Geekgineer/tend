#!/usr/bin/env node
// Tend's status line wrapper (spec §9.1). Claude runs it on every status update with the session JSON on stdin.
// 1. POST the JSON to Tend (fire and forget). 2. Run the user's own statusLine command with the same stdin and
// print its output unchanged. Argument: the session's 0600 status.json ({ url, token, session, launch }); the
// token never appears in argv.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

const here = import.meta.dirname;
const compiled = here.includes(`${sep}node_modules${sep}`) || !existsSync(join(here, '..', 'src', 'statusline.ts'));
const { userStatusLine } = await import(compiled ? '../dist/src/statusline.js' : '../src/statusline.ts');

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = Buffer.concat(chunks);

let conf = null;
try {
  conf = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'));
} catch {
  // no config: just pass the user's status line through
}
const post = conf
  ? fetch(conf.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tend-token': conf.token, 'x-tend-session': conf.session, 'x-tend-launch': conf.launch },
      body: input,
      signal: AbortSignal.timeout(300),
    }).catch(() => undefined)
  : Promise.resolve();

let project = null;
try {
  const j = JSON.parse(input.toString('utf8'));
  project = j?.workspace?.project_dir ?? j?.cwd ?? null;
} catch {
  // not JSON: no project settings
}
const cmd = userStatusLine(typeof project === 'string' ? project : null, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
if (cmd) {
  // its own process group, so a timeout stops everything it started
  const child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'inherit', 'ignore'], detached: true });
  const kill = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, 5000);
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
  await new Promise((r) => child.on('close', r));
  clearTimeout(kill);
}
await post;
