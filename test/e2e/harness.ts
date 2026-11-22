import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killSocket, startServer, tempHome, uniqueSocket } from '../helpers.ts';

// Shared harness for the lifecycle e2e files: one tend server (fake claude) per test file.

export const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');

export type Res = { status: number; body: string; json: () => any };
export type View = { id: string; state: { status: string }; paused: boolean; workspace: { mode: string; branch: string; worktree: string } };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until(fn: () => boolean | Promise<boolean>, ms: number, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}

export const git = (dir: string, ...a: string[]): string =>
  execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A flag's value from a launch argv, in either the `--x=v` or the `--x v` form. */
export function flag(argv: string[], f: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${f}=`));
  if (eq !== undefined) return eq.slice(f.length + 1);
  return argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined;
}

/** A temp repo under a `my #repo` folder, ignoring .env and node_modules/, with one commit. */
export function makeRepo(ignore = '.env\nnode_modules/\n'): string {
  const repo = join(realpathSync(tempHome()), 'my #repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, '.gitignore'), ignore);
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

export function lifecycleHarness() {
  const socket = uniqueSocket();
  const home = tempHome();
  let srv: Awaited<ReturnType<typeof startServer>>;
  const env = (): Record<string, string> => ({ TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'off', TEND_CLAUDE_BIN: FAKE });

  before(async () => {
    srv = await startServer(env());
  });
  after(async () => {
    await srv?.stop();
    killSocket(socket);
  });

  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
      const r = request(
        srv.url + path,
        { method, headers: { 'x-tend-token': srv.token, 'content-type': 'application/json', ...headers } },
        (res) => {
          let b = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode!, body: b, json: () => JSON.parse(b) }));
        },
      );
      r.on('error', reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  const tmux = (...a: string[]): string => execFileSync('tmux', ['-f', '/dev/null', '-L', socket, ...a], { encoding: 'utf8' });

  /** Wait until fake claude has drawn its prompt (its readline loop is up). */
  async function ready(id: string): Promise<void> {
    await until(() => {
      try {
        return tmux('capture-pane', '-p', '-t', `=tend-${id}:`).includes('fake claude');
      } catch {
        return false;
      }
    }, 5000, `fake claude in tend-${id}`);
  }

  async function create(cwd: string, name = 'life', isolate?: boolean): Promise<View> {
    const r = await call('POST', '/api/sessions', { cwd, name, ...(isolate === undefined ? {} : { isolate }) });
    assert.equal(r.status, 201, r.body);
    const v = r.json() as View;
    await ready(v.id);
    return v;
  }

  function type(id: string, text: string): void {
    tmux('send-keys', '-t', `=tend-${id}:`, '-l', text);
    tmux('send-keys', '-t', `=tend-${id}:`, 'Enter');
  }

  const briefing = async (id: string): Promise<any> => (await call('GET', `/api/sessions/${id}/briefing`)).json();
  const viewOf = async (id: string): Promise<View | undefined> =>
    ((await call('GET', '/api/sessions')).json() as View[]).find((s) => s.id === id);

  /** Type a command and wait until its Stop hook has been folded into the briefing. */
  async function turn(id: string, text: string): Promise<void> {
    const before = (await briefing(id)).done?.length ?? 0;
    type(id, text);
    await until(async () => ((await briefing(id)).done?.length ?? 0) > before, 5000, `turn "${text}"`);
  }

  /** Type `exit` and wait for the session to end. */
  async function exit(id: string): Promise<void> {
    type(id, 'exit');
    await until(async () => (await viewOf(id))?.state.status === 'ended', 5000, 'ended');
  }

  const stashOf = (id: string): string => join(realpathSync(home), 'paused', id);
  const argvFile = (id: string): string => join(home, 'sessions', id, 'argv.json');
  const readArgv = (id: string): string[] => JSON.parse(readFileSync(argvFile(id), 'utf8')) as string[];

  async function resumeAndWaitArgv(id: string): Promise<Res> {
    rmSync(argvFile(id), { force: true });
    const r = await call('POST', `/api/sessions/${id}/resume`);
    if (r.status === 200) await until(() => existsSync(argvFile(id)), 5000, 'argv.json after resume');
    return r;
  }

  const hook = (id: string, launch: string, body: unknown): Promise<Res> =>
    call('POST', '/hook', body, { 'x-tend-session': id, 'x-tend-launch': launch });

  /** Stop and start the server on the same home and tmux socket. */
  async function restart(): Promise<void> {
    await srv.stop();
    srv = await startServer({ ...env(), CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR! });
  }

  return {
    home, socket, call, tmux, ready, create, type, briefing, viewOf, turn, exit, stashOf, readArgv,
    resumeAndWaitArgv, hook, restart,
    get srv() {
      return srv;
    },
  };
}
