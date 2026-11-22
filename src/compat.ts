import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Surviving Claude Code updates (spec §20): Tend records `claude --version`; a version it hasn't checked gets a
// banner and an on-demand self-test. The self-test runs one tiny non-interactive prompt (`claude -p`, no trust
// dialog) in a temp repo against a private hook listener and checks every hook Tend relies on.

/** Versions this Tend was verified with (shipped); a passing local self-test adds to the list. */
export const SHIPPED_VERSIONS = ['2.1.312'];
const SELF_TEST_MS = 120_000;

export type TestResult = { version: string; ok: boolean; missing: string[]; at: number };
export type Compat = { version: string | null; verified: boolean; last: TestResult | null; running: boolean };

export function parseVersion(out: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(out)?.[1] ?? null;
}

/** `claude --version`, or null when it can't run (5 s at most). */
export function claudeVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : parseVersion(stdout)));
  });
}

type Store = { verified: string[]; last: TestResult | null };

export function createCompat(o: { home: string; bin: () => string; now?: () => number }) {
  const file = join(o.home, 'compat.json');
  const now = o.now ?? Date.now;
  let data: Store = { verified: [], last: null };
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Store>;
    const l = j.last as Partial<TestResult> | null | undefined;
    const last = l && typeof l.version === 'string' && typeof l.ok === 'boolean' && Array.isArray(l.missing) && typeof l.at === 'number'
      ? { version: l.version, ok: l.ok, missing: l.missing.filter((m) => typeof m === 'string'), at: l.at }
      : null;
    data = { verified: Array.isArray(j.verified) ? j.verified.filter((v) => typeof v === 'string') : [], last };
  } catch {
    // first run
  }
  let version: string | null = null;
  let running = false;
  const save = (): void => {
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${file}.tmp`, file); // never a half-written file
  };

  return {
    async refresh(): Promise<void> {
      version = await claudeVersion(o.bin());
    },
    view(): Compat {
      return { version, verified: version !== null && (SHIPPED_VERSIONS.includes(version) || data.verified.includes(version)), last: data.last, running };
    },
    /** Run the self-test for the installed version (one at a time). */
    async selfTest(): Promise<TestResult> {
      if (running) throw new Error('A self-test is already running.');
      running = true;
      try {
        await this.refresh();
        if (!version) throw new Error("claude --version didn't answer, so there's nothing to test.");
        const v = version;
        const missing = await selfTest(o.bin());
        const result: TestResult = { version: v, ok: missing.length === 0, missing, at: now() };
        data.last = result;
        if (result.ok && version && !data.verified.includes(version)) data.verified.push(version);
        save();
        return result;
      } finally {
        running = false;
      }
    },
  };
}

/**
 * One tiny prompt that makes Claude ask for a Bash permission, answered "allow" by our hook. Returns what didn't
 * work (empty = everything did).
 */
export async function selfTest(bin: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'tend-selftest-'));
  const secret = randomBytes(12).toString('hex'); // only this run's claude knows the hook path
  const expected = 'mkdir tend-selftest';
  const seen: Record<string, Record<string, unknown>> = {};
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      let j: Record<string, unknown> = {};
      try {
        j = JSON.parse(b) as Record<string, unknown>;
      } catch {
        // not JSON
      }
      if (req.url !== `/${secret}`) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const ev = typeof j.hook_event_name === 'string' ? j.hook_event_name : '';
      if (ev && !seen[ev]) seen[ev] = j;
      res.setHeader('content-type', 'application/json');
      if (ev !== 'PermissionRequest') {
        res.end('{}');
        return;
      }
      // allow exactly the one command the test asks for; anything else Claude tries is denied
      const input = (j.tool_input ?? {}) as { command?: unknown };
      const ok = j.tool_name === 'Bash' && input.command === expected;
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: ok ? { behavior: 'allow' } : { behavior: 'deny', message: 'Only the self-test command is allowed.' } } }));
    });
  });
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/${secret}`;
    const http = (ev: string) => [{ matcher: '', hooks: [{ type: 'http', url, timeout: ev === 'PermissionRequest' ? 60 : 10 }] }];
    const hooks: Record<string, unknown> = {};
    for (const ev of ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']) hooks[ev] = http(ev);
    hooks.SessionStart = [{ matcher: '', hooks: [{ type: 'command', command: `curl -s -m 3 --data-binary @- ${url} >/dev/null 2>&1 || true` }] }];
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks }));
    await run('git', ['init', '-q', dir], dir);
    const prompt = `Run this exact shell command and nothing else: ${expected}`;
    // isolated from the user's own settings, rules, hooks and MCP servers (the temp repo has no local settings)
    const args = ['-p', prompt, '--settings', join(dir, 'settings.json'), '--setting-sources', 'local', '--strict-mcp-config', '--model', 'haiku', '--permission-mode', 'default'];
    const code = await run(bin, args, dir, SELF_TEST_MS);
    const missing: string[] = [];
    if (code !== 0) missing.push(`claude -p exited with ${code}`);
    const need = (ev: string, fields: string[]): void => {
      const j = seen[ev];
      if (!j) missing.push(`${ev} hook`);
      else for (const f of fields) if (!(f in j)) missing.push(`${ev}.${f}`);
    };
    need('SessionStart', ['session_id']);
    need('UserPromptSubmit', ['session_id', 'prompt']);
    need('PreToolUse', ['tool_name', 'tool_input']);
    need('PermissionRequest', ['tool_name', 'tool_input']);
    need('PostToolUse', ['tool_name', 'tool_input']);
    need('Stop', ['last_assistant_message']);
    if (!existsSync(join(dir, 'tend-selftest'))) missing.push('a permission answered by the hook did not run the tool');
    return missing;
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(bin: string, args: string[], cwd: string, timeout = 30_000): Promise<number | null> {
  return new Promise((resolve) => {
    // its own process group: a timeout stops everything it started
    const c = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    const t = setTimeout(() => {
      try {
        if (c.pid) process.kill(-c.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, timeout);
    c.on('error', () => resolve(-1));
    c.on('close', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}
