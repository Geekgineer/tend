import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from './paths.ts';

export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd',
] as const;

type HookTarget = { port: number; token: string; sessionId: string; launch: string };

/** Single-quote a string for sh. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Claude Code 2.1.312 runs SessionStart only as a command hook (an http one is ignored), so that
 * event goes through curl. Token and headers live in a 0600 curl config, never in argv (`ps`).
 */
export function writeCurlConfig(home: string, sessionId: string, o: HookTarget): string {
  const dir = join(home, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'curl.conf');
  const lines = [
    `url = "http://127.0.0.1:${o.port}/hook"`,
    'header = "content-type: application/json"',
    `header = "x-tend-token: ${o.token}"`,
    `header = "x-tend-session: ${o.sessionId}"`,
    `header = "x-tend-launch: ${o.launch}"`,
  ];
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** The status line wrapper's 0600 config: where to POST, with which headers (keeps the token out of argv). */
export function writeStatusConfig(home: string, sessionId: string, o: HookTarget): string {
  const dir = join(home, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'status.json');
  writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${o.port}/status`, token: o.token, session: o.sessionId, launch: o.launch }) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

const WRAPPER = join(packageRoot(), 'bin', 'tend-statusline.mjs');

/**
 * A stable path for sessions' settings: `~/.tend/bin/tend-statusline`, rewritten at every start with the current
 * node and wrapper paths. Running sessions keep working after `brew upgrade node` or a moved checkout.
 */
export function writeStatusShim(home: string): string {
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'tend-statusline');
  // atomically: a status line running meanwhile never sees half a script
  writeFileSync(`${file}.tmp`, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(WRAPPER)} "$@"\n`, { mode: 0o700 });
  chmodSync(`${file}.tmp`, 0o700);
  renameSync(`${file}.tmp`, file);
  return file;
}

/** Claude runs this on every status update (and every 30 s while idle, so idle sessions keep reporting). */
export function statusLineSetting(statusConfig: string, shim?: string): object {
  const run = shim ? shq(shim) : `${shq(process.execPath)} ${shq(WRAPPER)}`;
  return { type: 'command', command: `${run} ${shq(statusConfig)}`, refreshInterval: 30 };
}

export function sessionStartCommand(curlConfig: string): string {
  return `curl -s -m 5 -K ${shq(curlConfig)} --data-binary @- >/dev/null 2>&1 || true`;
}

/** How long a permission card can wait; then Claude closes the request and its dialog decides. */
export const PERMISSION_TIMEOUT_S = 3600;

export function buildSettings(o: HookTarget & { curlConfig?: string; statusConfig?: string; shim?: string }): object {
  const hooks: Record<string, unknown[]> = {};
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [
      {
        matcher: '',
        hooks: [
          {
            type: 'http',
            url: `http://127.0.0.1:${o.port}/hook`,
            // a held PermissionRequest waits for the user (Claude's own dialog stays usable meanwhile)
            timeout: ev === 'PermissionRequest' ? PERMISSION_TIMEOUT_S : 10,
            headers: { 'x-tend-token': o.token, 'x-tend-session': o.sessionId, 'x-tend-launch': o.launch },
          },
        ],
      },
    ];
  }
  if (o.curlConfig) hooks.SessionStart = [{ matcher: '', hooks: [{ type: 'command', command: sessionStartCommand(o.curlConfig), timeout: 10 }] }];
  return o.statusConfig ? { hooks, statusLine: statusLineSetting(o.statusConfig, o.shim) } : { hooks };
}

export function writeSettings(home: string, sessionId: string, settings: object): string {
  const dir = join(home, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function launchArgv(bin: string, settingsPath: string, name: string, claude: { id: string; resume: boolean }, addDirs: string[] = []): string[] {
  const extra = (process.env.TEND_CLAUDE_ARGS ?? '').split(/\s+/).filter(Boolean);
  // --name=<v> as one argument: a name from outside tend (Adopt) that starts with '-' can never read as a flag
  const dirs = addDirs.flatMap((d) => ['--add-dir', d]); // in-place attachments live outside the folder
  return [bin, '--settings', settingsPath, `--name=${name}`, `${claude.resume ? '--resume' : '--session-id'}=${claude.id}`, ...dirs, ...extra];
}

export function claudeBin(): string {
  return process.env.TEND_CLAUDE_BIN || 'claude';
}

/** The environment for a session's tmux pane under an account (a Claude config folder). */
export function launchEnv(id: string, account: string, homeClaude: string): Record<string, string> {
  const env: Record<string, string> = { TEND_SESSION: id };
  if (account !== homeClaude) env.CLAUDE_CONFIG_DIR = account;
  return env;
}

/**
 * The command for an account: ~/.claude must run with no CLAUDE_CONFIG_DIR at all (setting it to ~/.claude makes
 * Claude look for its state in ~/.claude/.claude.json and appear logged out), even if tmux or Tend has one.
 */
export const forAccount = (argv: string[], account: string, homeClaude: string): string[] =>
  account === homeClaude ? ['env', '-u', 'CLAUDE_CONFIG_DIR', ...argv] : argv;

/** Settings (hooks + status line) and their 0600 helper files for one launch; returns the settings path. */
export function writeLaunchFiles(home: string, o: HookTarget): string {
  return writeSettings(home, o.sessionId, buildSettings({ ...o, curlConfig: writeCurlConfig(home, o.sessionId, o), statusConfig: writeStatusConfig(home, o.sessionId, o), shim: writeStatusShim(home) }));
}
