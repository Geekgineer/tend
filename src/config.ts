import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function tendHome(): string {
  const home = process.env.TEND_HOME || join(homedir(), '.tend');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700); // mkdir's mode is ignored for a dir that already exists
  return home;
}

export function port(): number {
  const n = Number(process.env.TEND_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4977;
}

/**
 * The UI token (printed in the link). Hooks get a separate one (`hook-token`, see loadOrCreateHookToken):
 * it sits in every session's settings file, readable by code Claude runs, so it must not answer cards.
 */
export function loadOrCreateToken(home: string, name = 'token'): string {
  const file = join(home, name);
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      chmodSync(file, 0o600);
      return existing;
    }
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/** The token Claude's hooks send; accepted only on POST /hook. */
export const loadOrCreateHookToken = (home: string): string => loadOrCreateToken(home, 'hook-token');

/** A fresh UI token (`tend rotate-token`): every link and cookie with the old one stops working. */
export function rotateToken(home: string): string {
  const file = join(home, 'token');
  const token = randomBytes(32).toString('hex');
  // never a half-written token file (a running tend reads it as soon as it changes)
  writeFileSync(`${file}.tmp`, token + '\n', { mode: 0o600 });
  chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
  return token;
}

export type Lock = { pid: number; port: number; nonce: string; at?: number };

/** A lock this young belongs to a tend that may still be starting (not listening yet). */
const STARTING_MS = 10_000;

/** The lock file as written, or null. Whether its owner is really running is `lockOwnerAlive`'s question. */
export function readLock(home: string): Lock | null {
  try {
    const l = JSON.parse(readFileSync(join(home, 'tend.lock'), 'utf8')) as Lock;
    return Number.isInteger(l.pid) && l.pid > 0 && Number.isInteger(l.port) && typeof l.nonce === 'string' ? l : null;
  } catch {
    return null;
  }
}

/** Is the tend that wrote this lock still serving? Asks it (an unrelated process reusing the pid can't answer). */
export async function lockOwnerAlive(l: Lock): Promise<boolean> {
  if (typeof l.at === 'number' && Date.now() - l.at < STARTING_MS) return true;
  try {
    const r = await fetch(`http://127.0.0.1:${l.port}/health`, { signal: AbortSignal.timeout(1500) });
    return ((await r.json()) as { instance?: unknown }).instance === l.nonce;
  } catch {
    return false;
  }
}

/** Take the lock: atomically when free, replacing a stale one. Returns false if a live tend holds it. */
export async function takeLock(home: string, port: number, nonce: string): Promise<boolean> {
  const file = join(home, 'tend.lock');
  const body = JSON.stringify({ pid: process.pid, port, nonce, at: Date.now() }) + '\n';
  try {
    writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    const l = readLock(home);
    if (l && (await lockOwnerAlive(l))) return false;
    writeFileSync(file, body, { mode: 0o600 });
    return true;
  }
}

/** Once serving: (re)write the lock as ours, in case a racing starter replaced it before losing the port. */
export function confirmLock(home: string, port: number, nonce: string): void {
  writeFileSync(join(home, 'tend.lock'), JSON.stringify({ pid: process.pid, port, nonce }) + '\n', { mode: 0o600 });
}

export function removeLock(home: string, nonce: string): void {
  if (readLock(home)?.nonce === nonce) rmSync(join(home, 'tend.lock'), { force: true });
}
