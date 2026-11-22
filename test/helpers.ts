import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'tend-test-'));
}

export function uniqueSocket(): string {
  return `tend-test-${process.pid}-${randomBytes(4).toString('hex')}`;
}

export function killSocket(socket: string): void {
  try {
    execFileSync('tmux', ['-f', '/dev/null', '-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // no server running
  }
  // kill-server leaves a stale socket file behind; remove it (only ever our own unique test sockets)
  if (socket.startsWith('tend-test-')) rmSync(join('/private/tmp', `tmux-${userInfo().uid}`, socket), { force: true });
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/**
 * Start a tend server in-process. `env` holds TEND_* overrides (TEND_HOME, TEND_TMUX_SOCKET,
 * TEND_NOTIFY, TEND_CLAUDE_BIN, TEND_PORT); they are also copied into process.env because
 * the launcher reads TEND_CLAUDE_BIN from there.
 */
export async function startServer(
  env: Record<string, string>,
): Promise<{ url: string; token: string; port: number; home: string; socket: string; stop(): Promise<void> }> {
  const { startServer: start } = await import('../src/server.ts');
  const { loadOrCreateToken } = await import('../src/config.ts');
  // never let a test write into a real Claude config dir
  // ...and never let one pick up a real ~/.claude-* account (':' = no extra accounts)
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'tend-claude-')), TEND_ACCOUNTS: ':' }, env);
  const home = env.TEND_HOME ?? tempHome();
  // tests expect notifications at once unless they test focus windows (TEND_FOCUS=1)
  if (!env.TEND_FOCUS && !existsSync(join(home, 'settings.json'))) writeFileSync(join(home, 'settings.json'), JSON.stringify({ focus: { enabled: false } }));
  const port = env.TEND_PORT ? Number(env.TEND_PORT) : await freePort();
  const token = loadOrCreateToken(home);
  const socket = env.TEND_TMUX_SOCKET ?? uniqueSocket();
  const srv = await start({
    home,
    port,
    token,
    tmuxSocket: socket,
    notifyMode: env.TEND_NOTIFY ?? 'off',
    ...(env.TEND_WATCH_MS ? { watchIntervalMs: Number(env.TEND_WATCH_MS) } : {}),
  });
  return { url: `http://127.0.0.1:${port}`, token, port, home, socket, stop: () => srv.close() };
}

/** The launch nonce a session's hooks send, read back from its generated settings.json. */
export function launchOf(home: string, id: string): string {
  const s = JSON.parse(readFileSync(join(home, 'sessions', id, 'settings.json'), 'utf8')) as {
    hooks: { Stop: { hooks: { headers: Record<string, string> }[] }[] };
  };
  return s.hooks.Stop[0]!.hooks[0]!.headers['x-tend-launch']!;
}
