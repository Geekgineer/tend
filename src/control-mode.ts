import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

const isOct = (c: number): boolean => c >= 0x30 && c <= 0x37;

/**
 * Decode one control-mode line. Input must come from a latin1-decoded stream, so every
 * char code is one raw byte. tmux escapes bytes < 0x20 and backslash as \ooo octal.
 * Never re-encode chars as UTF-8: push the byte itself.
 */
export function decodeOutput(line: string): { pane: string; bytes: Buffer } | null {
  if (!line.startsWith('%output ')) return null;
  const sp = line.indexOf(' ', 8);
  if (sp < 0) return null;
  const pane = line.slice(8, sp);
  const out = Buffer.allocUnsafe(line.length - sp - 1);
  let n = 0;
  for (let i = sp + 1; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (
      c === 0x5c &&
      i + 3 < line.length &&
      isOct(line.charCodeAt(i + 1)) &&
      isOct(line.charCodeAt(i + 2)) &&
      isOct(line.charCodeAt(i + 3))
    ) {
      out[n++] = parseInt(line.slice(i + 1, i + 4), 8) & 0xff;
      i += 3;
    } else {
      out[n++] = c & 0xff;
    }
  }
  return { pane, bytes: out.subarray(0, n) };
}

/** Only Tend's own sessions are attachable; the name reaches a tmux command line. */
export const CONTROL_SESSION = /^tend-[0-9a-f]{8}$/;

/** A tmux control-mode client attached to one session. `close()` detaches gracefully (stdin EOF). */
export class ControlClient {
  private proc: ChildProcessByStdio<Writable, Readable, null>;
  private session: string;
  private listeners = new Set<(b: Buffer) => void>();
  private exitListeners = new Set<() => void>();
  private acc = '';
  private exited = false;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(socket: string, session: string) {
    if (!CONTROL_SESSION.test(session)) throw new Error(`Invalid control-mode session name: ${JSON.stringify(session)}`);
    this.session = session;
    // window-size is manual: no refresh-client -C here; size is controlled only by Tmux.resize.
    // '=' makes the target an exact match (no prefix matching onto another session).
    this.proc = spawn('tmux', ['-f', '/dev/null', '-L', socket, '-C', 'attach', '-t', `=${session}`], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.proc.stdout.setEncoding('latin1');
    this.proc.stdout.on('data', (d: string) => this.onData(d));
    this.proc.stdin.on('error', () => {});
    this.proc.on('error', () => this.markExited());
    this.proc.on('exit', () => this.markExited());
  }

  private markExited(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = undefined;
    if (this.exited) return;
    this.exited = true;
    this.listeners.clear();
    const fns = [...this.exitListeners];
    this.exitListeners.clear();
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  private onData(d: string): void {
    this.acc += d;
    let i: number;
    while ((i = this.acc.indexOf('\n')) >= 0) {
      let line = this.acc.slice(0, i);
      this.acc = this.acc.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '%exit' || line.startsWith('%exit ')) {
        this.markExited();
        continue;
      }
      const r = decodeOutput(line);
      if (r) for (const fn of this.listeners) fn(r.bytes);
    }
  }

  get alive(): boolean {
    return !this.exited;
  }

  onBytes(fn: (b: Buffer) => void): () => void {
    if (this.exited) return () => {};
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Fires once when the control-mode client exits (process exit, spawn error or %exit). */
  onExit(fn: () => void): () => void {
    if (this.exited) {
      fn();
      return () => {};
    }
    this.exitListeners.add(fn);
    return () => {
      this.exitListeners.delete(fn);
    };
  }

  sendKeys(data: Buffer): void {
    if (data.length === 0 || this.exited || !this.proc.stdin.writable) return;
    const hex = [...data].map((x) => x.toString(16).padStart(2, '0')).join(' ');
    // trailing ':' so '=name' parses as an exact session target, not a pane
    this.proc.stdin.write(`send-keys -t =${this.session}: -H ${hex}\n`);
  }

  close(): void {
    this.listeners.clear();
    if (this.exited) return;
    // EOF detaches after tmux has run any queued commands (e.g. a final send-keys)
    this.proc.stdin.end();
    if (!this.killTimer) {
      this.killTimer = setTimeout(() => this.proc.kill('SIGKILL'), 2000);
      this.killTimer.unref();
    }
  }
}

// ---- ref-counted pool -------------------------------------------------------

type Entry = { key: string; client: ControlClient; count: number };
const pool = new Map<string, Entry>();
const byClient = new Map<ControlClient, Entry>();

/** The live client for `socket + session`, shared by every holder; pair each call with `release`. */
export function acquire(socket: string, session: string): ControlClient {
  const key = `${socket}\0${session}`;
  const hit = pool.get(key);
  if (hit && hit.client.alive) {
    hit.count++;
    return hit.client;
  }
  if (hit) drop(hit);
  const client = new ControlClient(socket, session);
  const entry: Entry = { key, client, count: 1 };
  pool.set(key, entry);
  byClient.set(client, entry);
  client.onExit(() => drop(entry));
  return client;
}

function drop(entry: Entry): void {
  if (pool.get(entry.key) === entry) pool.delete(entry.key);
  byClient.delete(entry.client);
}

/** Drop one hold on `client`; the client is closed when the last hold is released. */
export function release(client: ControlClient): void {
  const entry = byClient.get(client);
  if (!entry) return;
  entry.count--;
  if (entry.count > 0) return;
  drop(entry);
  client.close();
}

/** Number of pooled (live, held) control clients. */
export function activeClients(): number {
  return pool.size;
}
