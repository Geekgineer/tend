import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from './errors.ts';

// Tend's own settings (spec §22): pace and attention. Never Claude's settings.

export type Settings = {
  focus: { enabled: boolean; minutes: number };
  quiet: { enabled: boolean; start: string; end: string };
  /** notifications per hour before the rest is held */
  budgetPerHour: number;
  /** soft limit on active sessions (a note, never a block) */
  wipLimit: number;
};

export const DEFAULTS: Settings = {
  focus: { enabled: true, minutes: 25 },
  quiet: { enabled: false, start: '22:00', end: '08:00' },
  budgetPerHour: 6,
  wipLimit: 8,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A full Settings from untrusted input; throws UserError naming the first bad field. */
export function validate(v: unknown, base: Settings = DEFAULTS): Settings {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const f = (typeof o.focus === 'object' && o.focus !== null ? o.focus : {}) as Record<string, unknown>;
  const q = (typeof o.quiet === 'object' && o.quiet !== null ? o.quiet : {}) as Record<string, unknown>;
  const bool = (x: unknown, d: boolean, name: string): boolean => {
    if (x === undefined) return d;
    if (typeof x !== 'boolean') throw new UserError(`${name} must be true or false`);
    return x;
  };
  const int = (x: unknown, d: number, lo: number, hi: number, name: string): number => {
    if (x === undefined) return d;
    if (typeof x !== 'number' || !Number.isInteger(x) || x < lo || x > hi) throw new UserError(`${name} must be a whole number from ${lo} to ${hi}`);
    return x;
  };
  const time = (x: unknown, d: string, name: string): string => {
    if (x === undefined) return d;
    if (typeof x !== 'string' || !HHMM.test(x)) throw new UserError(`${name} must be a time like 22:00`);
    return x;
  };
  return {
    focus: { enabled: bool(f.enabled, base.focus.enabled, 'focus.enabled'), minutes: int(f.minutes, base.focus.minutes, 5, 240, 'focus.minutes') },
    quiet: {
      enabled: bool(q.enabled, base.quiet.enabled, 'quiet.enabled'),
      start: time(q.start, base.quiet.start, 'quiet.start'),
      end: time(q.end, base.quiet.end, 'quiet.end'),
    },
    budgetPerHour: int(o.budgetPerHour, base.budgetPerHour, 1, 60, 'budgetPerHour'),
    wipLimit: int(o.wipLimit, base.wipLimit, 1, 100, 'wipLimit'),
  };
}

export function createSettings(home: string) {
  const file = join(home, 'settings.json');
  let current: Settings;
  try {
    current = validate(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    current = DEFAULTS; // no file or a bad one
  }
  return {
    get: (): Settings => current,
    /** Merge a partial update, validate, save (0600). */
    update(patch: unknown): Settings {
      current = validate(patch, current);
      writeFileSync(file, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
      chmodSync(file, 0o600);
      return current;
    },
  };
}

/** Is `at` inside quiet hours (start..end, crossing midnight when end < start)? Local time. */
export function inQuiet(s: Settings, at: number): boolean {
  if (!s.quiet.enabled) return false;
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  const min = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const a = min(s.quiet.start);
  const b = min(s.quiet.end);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}
