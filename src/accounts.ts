import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// An account is a Claude config folder (spec §9.2). Logging in stays Claude's job (`CLAUDE_CONFIG_DIR=<dir> claude`,
// then /login); Tend never reads credentials. Limits are per account, context is per session.

export type Account = { dir: string; name: string };

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The config folder Claude uses without CLAUDE_CONFIG_DIR, or the one Tend itself was started with. */
export const defaultAccountDir = (): string => resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));

/** Does a folder look like a Claude config folder (not a backup or another tool's folder)? */
const looksLikeConfig = (dir: string): boolean =>
  ['.claude.json', 'settings.json', 'projects', '.credentials.json'].some((n) => {
    try {
      statSync(join(dir, n));
      return true;
    } catch {
      return false;
    }
  });

export const HOME_CLAUDE = (): string => join(homedir(), '.claude');

/**
 * The default folder plus `~/.claude-<name>` / `~/.claude<N>` folders. `TEND_ACCOUNTS` (colon-separated folders)
 * replaces the scan, for tests and unusual setups.
 */
export function listAccounts(): Account[] {
  const def = defaultAccountDir();
  const out: Account[] = [{ dir: def, name: 'Default' }];
  const extra = process.env.TEND_ACCOUNTS
    ? process.env.TEND_ACCOUNTS.split(':').filter(Boolean).map((d) => resolve(d))
    : (() => {
        try {
          return [
            HOME_CLAUDE(), // listed too when Tend itself runs with another CLAUDE_CONFIG_DIR
            ...readdirSync(homedir())
              .filter((n) => /^\.claude([-_.][\w-]+|\d+)$/.test(n) && n !== '.claude.json')
              .map((n) => join(homedir(), n)),
          ];
        } catch {
          return [];
        }
      })();
  for (const dir of extra) {
    if (dir === def || !isDir(dir) || out.some((a) => a.dir === dir)) continue;
    if (!process.env.TEND_ACCOUNTS && !looksLikeConfig(dir)) continue;
    out.push({ dir, name: dir === HOME_CLAUDE() ? 'claude' : basename(dir).replace(/^\.claude[-_.]?/, '') || basename(dir) });
  }
  return out;
}
