import { execFileSync, spawnSync } from 'node:child_process';

export interface Tmux {
  available(): boolean;
  ensureServerOptions(): void;
  newSession(
    name: string,
    cwd: string,
    argv: string[],
    cols: number,
    rows: number,
    env: Record<string, string>,
  ): void;
  list(): string[];
  has(name: string): boolean;
  paneDead(name: string): boolean;
  kill(name: string): void;
  resize(name: string, cols: number, rows: number): void;
  snapshot(name: string): Buffer;
}

/**
 * tmux splits its argv into commands at any argument *ending* in ';' (so 'x;' runs 'x' and
 * starts a new command). A trailing '\;' is turned back into a literal ';' and nothing else
 * is touched (verified on tmux 3.8: 'q\' + ';' → 'q\\;' → 'q\;').
 */
export const escArg = (s: string): string => (s.endsWith(';') ? `${s.slice(0, -1)}\\;` : s);

export function createTmux(socket: string): Tmux {
  const base = ['-f', '/dev/null', '-L', socket];
  const run = (...args: string[]): string =>
    execFileSync('tmux', [...base, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = (...args: string[]): boolean =>
    spawnSync('tmux', [...base, ...args], { stdio: 'ignore' }).status === 0;
  // exact-match target (the leading '=' stops tmux prefix-matching session names)
  const target = (name: string): string => `=${name}`;
  // pane/window commands need a trailing ':' so '=name' parses as a session, not a pane
  const pane = (name: string): string => `=${name}:`;

  return {
    available() {
      return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
    },
    ensureServerOptions() {
      // fails harmlessly (non-zero) when no server is running
      ok('set', '-g', 'remain-on-exit', 'on', ';', 'set', '-g', 'window-size', 'manual', ';', 'set', '-g', 'focus-events', 'on');
    },
    newSession(name, cwd, argv, cols, rows, env) {
      const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', escArg(`${k}=${v}`)]);
      run(
        'start-server', ';',
        'set', '-g', 'remain-on-exit', 'on', ';',
        'set', '-g', 'window-size', 'manual', ';',
        'set', '-g', 'focus-events', 'on', ';', // else Claude prints a "tmux focus-events off" hint
        'new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows),
        '-c', escArg(cwd.replaceAll('#', '##')), // -c is format-expanded: '##' is a literal '#'
        ...envArgs, ...argv.map(escArg),
      );
    },
    list() {
      try {
        return run('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    has(name) {
      return ok('has-session', '-t', target(name));
    },
    paneDead(name) {
      try {
        return run('display', '-p', '-t', pane(name), '#{pane_dead}').trim() === '1';
      } catch {
        return false;
      }
    },
    kill(name) {
      ok('kill-session', '-t', target(name));
    },
    resize(name, cols, rows) {
      run('resize-window', '-t', pane(name), '-x', String(cols), '-y', String(rows));
    },
    snapshot(name) {
      const t = pane(name);
      const screen = run('capture-pane', '-p', '-e', '-t', t);
      const [cx, cy] = run('display', '-p', '-t', t, '#{cursor_x} #{cursor_y}').trim().split(' ').map(Number);
      const body = screen.replace(/\n$/, '').replace(/\n/g, '\r\n');
      return Buffer.from(`\x1b[2J\x1b[H${body}\x1b[${cy! + 1};${cx! + 1}H`, 'utf8');
    },
  };
}
