import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { UserError } from './errors.ts';

const PANEL_SCRIPT = join(import.meta.dirname, 'folder-panel.jxa');
const READY_MS = 10_000;

type Helper = { proc: ChildProcess; ready: Promise<void>; next: ((line: string | null) => void)[] };
let helper: Helper | null = null;
let open = false;
let cancelled = false;

/** Close an open folder window from the page (it may be hidden on another desktop): counts as Cancel. */
export function cancelFolderPanel(): boolean {
  if (!open) return false;
  cancelled = true;
  stopFolderPanel(); // the window goes with its helper; the next Choose starts a fresh one
  return true;
}

const bin = (): string => process.env.TEND_OSASCRIPT || 'osascript';

/** Start the long-running folder-window helper (macOS only) so the first Choose… opens at once. */
export function warmFolderPanel(): void {
  if (process.platform === 'darwin' && helper === null) helper = startHelper();
}

export function stopFolderPanel(): void {
  const h = helper;
  helper = null;
  if (!h) return;
  for (const w of h.next.splice(0)) w(null); // whoever waits on it is answered now, not when it exits
  h.proc.kill();
  // a helper that ignores SIGTERM (blocked in a modal) is killed for sure
  setTimeout(() => {
    if (h.proc.exitCode === null && h.proc.signalCode === null) h.proc.kill('SIGKILL');
  }, 1000).unref();
}

function startHelper(): Helper {
  const proc = spawn(bin(), ['-l', 'JavaScript', PANEL_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] });
  const h: Helper = { proc, ready: Promise.resolve(), next: [] };
  let gotReady: () => void = () => undefined;
  let failReady: (e: Error) => void = () => undefined;
  h.ready = new Promise((resolve, reject) => {
    gotReady = resolve;
    failReady = reject;
  });
  h.ready.catch(() => undefined); // nobody may be waiting yet
  const timer = setTimeout(() => failReady(new Error('folder window helper not ready')), READY_MS);
  timer.unref();
  createInterface({ input: proc.stdout! }).on('line', (line) => {
    if (line === 'ready') {
      clearTimeout(timer);
      gotReady();
    } else h.next.shift()?.(line);
  });
  const gone = (): void => {
    clearTimeout(timer);
    failReady(new Error('folder window helper exited'));
    for (const w of h.next.splice(0)) w(null);
    if (helper === h) helper = null;
  };
  proc.on('exit', gone);
  proc.on('error', gone);
  proc.stdin!.on('error', () => undefined);
  proc.unref();
  (proc.stdout as unknown as { unref?: () => void }).unref?.();
  return h;
}

/**
 * Show the macOS "Choose a folder" window on this machine and return the picked folder, or null if
 * the user cancelled. One window at a time.
 */
export async function chooseFolder(start: string | undefined): Promise<string | null> {
  if (process.platform !== 'darwin') throw new UserError('The Finder folder window is only on macOS. Type the path instead.');
  if (open) throw new UserError('The folder window is already open.');
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const from = start && !start.includes('\n') && isDir(start) ? start : homedir();
  open = true;
  cancelled = false;
  try {
    warmFolderPanel();
    const h = helper!;
    try {
      await h.ready;
    } catch {
      stopFolderPanel();
      if (cancelled) return null; // cancelled while it was starting
      throw new UserError('Could not open the folder window.');
    }
    if (cancelled) return null;
    const line = await new Promise<string | null>((resolve) => {
      h.next.push(resolve);
      h.proc.stdin!.write(from + '\n');
    });
    if (line === null) {
      if (cancelled) return null;
      throw new UserError('Could not open the folder window.');
    }
    return line === '' ? null : line.length > 1 ? line.replace(/\/+$/, '') : line;
  } finally {
    open = false;
    stopFolderPanel(); // never leave a helper running once its window closed (it would hold focus, unresponsive)
  }
}
