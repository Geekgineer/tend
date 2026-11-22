import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type RiskLevel = 'high' | 'medium' | 'low';
export type Risk = { level: RiskLevel; rule: string };
export type RiskRule = { level: RiskLevel; rule: string; pattern: RegExp };

// Rules, not AI. Matched against a Bash command; first match wins, high before medium.
// Extra rules can be added in ~/.tend/risk-rules.json: [{ "level": "high", "rule": "...", "pattern": "regex" }].
const GIT = String.raw`\bgit(\s+-[cC]\s+\S+)*\s+`; // `git -C repo push` is still a push

export const DEFAULT_RULES: RiskRule[] = [
  { level: 'high', rule: 'Recursive delete', pattern: /\brm\b(\s+-\S+)*\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b|\brmdir\s+\/s\b|\bfind\b.*\s(-delete\b|-exec\s+rm\b)/i },
  { level: 'high', rule: 'Deletes files from code', pattern: /\b(rmtree|shutil\.rmtree|os\.remove|os\.unlink|fs\.rm(Sync)?|unlinkSync)\b|\bshred\b|\bsrm\b/ },
  { level: 'high', rule: 'Force push', pattern: new RegExp(`${GIT}push\\b.*(\\s--force(-with-lease)?\\b|\\s-f\\b|\\s\\+\\S)`) },
  { level: 'high', rule: 'Hard reset', pattern: new RegExp(`${GIT}reset\\b.*--hard\\b`) },
  {
    level: 'high',
    rule: 'Discards uncommitted work',
    pattern: new RegExp(`${GIT}(clean\\s+-[a-zA-Z]*f|checkout\\s+(--\\s+)?\\.(\\s|$)|checkout\\s+--\\s|restore\\s|branch\\s+-D\\b|stash\\s+(drop|clear)\\b)`),
  },
  { level: 'high', rule: 'SQL drop or truncate', pattern: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+(TABLE\s+)?\w)/i },
  { level: 'high', rule: 'SQL delete without WHERE', pattern: /\bDELETE\s+FROM\s+[\w."`]+\s*(;|"|'|$)(?![\s\S]*\bWHERE\b)/i },
  { level: 'high', rule: 'Runs as root', pattern: /(^|[;&|(`]\s*|\$\(\s*)sudo\b/m },
  {
    level: 'high',
    rule: 'Runs downloaded code',
    pattern: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?((ba|z|da|k)?sh|python3?|perl|ruby|node)\b|<\(\s*(curl|wget)\b|\$\(\s*(curl|wget)\b|`\s*(curl|wget)\b/,
  },
  { level: 'high', rule: 'Wipes a disk', pattern: /\bdd\b.*\bof=\/dev\/|\bmkfs(\.\w+)?\b|\bdiskutil\s+(erase\w*|partition\w*|zeroDisk)\b/ },
  {
    level: 'high',
    rule: 'Destructive cloud command',
    pattern: /\b(aws\s+\S+\s+(rm|delete\S*|terminate\S*)|gcloud\b.*\bdelete\b|kubectl\s+delete\b|terraform\s+(apply|destroy)\b|az\b.*\bdelete\b|pulumi\s+(destroy|up)\b|helm\s+(uninstall|delete)\b|gh\s+repo\s+delete\b|docker\s+(system|volume|image|container)\s+prune\b)/,
  },
  { level: 'high', rule: 'Changes permissions recursively', pattern: /\bch(mod|own)\b.*\s-[a-zA-Z]*R\b/ },
  { level: 'medium', rule: 'Git push', pattern: new RegExp(`${GIT}push\\b`) },
  { level: 'medium', rule: 'Package install', pattern: /\b(npm\s+(i|install|add|ci)\b|pnpm\s+(i|install|add)\b|yarn\s+(add|install)\b|bun\s+(add|install)\b|pip3?\s+install\b|uv\s+(add|pip\s+install)\b|brew\s+install\b|cargo\s+(add|install)\b|go\s+install\b|gem\s+install\b|composer\s+(require|install)\b|apt(-get)?\s+install\b)/ },
  { level: 'medium', rule: 'Database migration', pattern: /\b(migrate|migration|db:migrate|alembic\s+upgrade|prisma\s+migrate)\b/ },
  { level: 'medium', rule: 'Network call', pattern: /\b(curl|wget|ssh|scp|rsync|nc|telnet)\b/ },
  { level: 'medium', rule: 'Runs a nested shell command', pattern: /\b(ba|z|da)?sh\s+-c\b|\beval\b|\$\(|`|\bxargs\b|\n/ },
];

/** Longer commands skip the rules (slow to scan, easy to hide in) and count as high. */
export const MAX_CHECKED = 8 * 1024;

let cache: { file: string; mtime: number; rules: RiskRule[] } | null = null;

/** loadRules, re-read only when the file changes. */
export function cachedRules(file: string): RiskRule[] {
  let mtime = -1;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    // no file
  }
  if (cache?.file === file && cache.mtime === mtime) return cache.rules;
  cache = { file, mtime, rules: loadRules(file) };
  return cache.rules;
}

/** Rules from `~/.tend/risk-rules.json` (if any), placed before the defaults. Bad entries are skipped. */
export function loadRules(file: string): RiskRule[] {
  let extra: RiskRule[] = [];
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) {
      extra = raw.flatMap((r) => {
        if (typeof r !== 'object' || r === null) return [];
        const { level, rule, pattern } = r as Record<string, unknown>;
        if ((level !== 'high' && level !== 'medium' && level !== 'low') || typeof rule !== 'string' || typeof pattern !== 'string' || pattern.length > 500) return [];
        try {
          return [{ level, rule, pattern: new RegExp(pattern, 'i') }];
        } catch {
          return [];
        }
      });
    }
  } catch {
    // no file, or not JSON: defaults only
  }
  return [...extra, ...DEFAULT_RULES];
}

const ORDER: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** The real path of `p`, following symlinks through its deepest existing parent. */
function real(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return p;
  }
}

/** `path` (absolute, `~/…`, or relative to `root`) relative to `root`, symlinks resolved; null when outside. */
function inside(root: string, path: string): string | null {
  const abs = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : resolve(root, path);
  const rel = relative(real(root), real(abs));
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel) ? null : rel;
}

/** Risk of a permission request: the highest-level matching rule, or low. `root` is the session folder. */
export function classify(tool: string, input: Record<string, unknown>, root: string, rules: RiskRule[] = DEFAULT_RULES): Risk {
  if (tool === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command;
    if (cmd.length > MAX_CHECKED) return { level: 'high', rule: 'Very long command (not checked)' };
    const hits = rules.filter((r) => r.pattern.test(cmd)).sort((a, b) => ORDER[a.level] - ORDER[b.level]);
    if (hits[0]) return { level: hits[0].level, rule: hits[0].rule };
    return { level: 'low', rule: 'No rule matched' };
  }
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  if (EDIT_TOOLS.has(tool) && path !== null) {
    const rel = inside(root, path);
    if (rel === null) return { level: 'high', rule: 'Writes outside the session folder' };
    // git hooks and Claude's settings run as code later
    if (/(^|\/)(\.git|\.claude)(\/|$)/i.test(rel) || /(^|\/)\.envrc$/.test(rel)) return { level: 'high', rule: 'Changes Git or Claude settings' };
    return { level: 'low', rule: 'Edits a file in the session folder' };
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') return { level: 'medium', rule: 'Network call' };
  return { level: 'low', rule: 'No rule matched' };
}
