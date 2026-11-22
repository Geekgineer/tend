import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';

export const SESSION_ID = /^[0-9a-f]{8}$/;
export const isSessionId = (id: unknown): id is string => typeof id === 'string' && SESSION_ID.test(id);

export const tmuxName = (id: string): string => `tend-${id}`;

const MAX_NAME = 120;

export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function cleanName(name: string | undefined, cwd: string): string {
  // strip control characters: names reach tmux argv and the UI (never a shell)
  const n = (name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME);
  return n || basename(cwd) || cwd;
}
