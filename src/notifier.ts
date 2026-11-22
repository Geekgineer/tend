import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { NotifyIntent } from './state.ts';

export type NotifyMode = 'osascript' | 'stub' | 'off';

export function notifyModeFromEnv(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): NotifyMode {
  const v = env.TEND_NOTIFY;
  if (v === 'osascript' || v === 'stub' || v === 'off') return v;
  return platform === 'darwin' ? 'osascript' : 'off';
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function defaultRun(cmd: string, args: string[]): void {
  try {
    execFile(cmd, args, () => {}).on('error', () => {});
  } catch {
    // a failed notification must never crash the server
  }
}

export function createNotifier(o: {
  mode: NotifyMode;
  stubFile?: string;
  run?: (cmd: string, args: string[]) => void;
}): (i: NotifyIntent) => void {
  const run = o.run ?? defaultRun;
  return (i) => {
    try {
      if (o.mode === 'osascript') {
        run('osascript', ['-e', `display notification "${esc(i.body)}" with title "${esc(i.title)}" subtitle "tend."`]);
      } else if (o.mode === 'stub' && o.stubFile) {
        fs.appendFileSync(o.stubFile, JSON.stringify(i) + '\n');
      }
    } catch {
      // never throw from a notification
    }
  };
}
