// Sanitises raw hook payloads captured from a real Claude Code run into test/fixtures/phase0/. Idempotent.
// Usage: node scripts/sanitize-fixtures.ts <folder of raw captures>
// Your home folder, user name, temp folders and every UUID are replaced, so fixtures are safe to commit.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const SRC = resolve(process.argv[2] ?? join(root, 'captures'));
const OUT = join(root, 'test', 'fixtures', 'phase0');
const ZERO = '00000000-0000-0000-0000-000000000000';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOME = homedir();
const USER = userInfo().username;
const UID = String(userInfo().uid);

const RULES: Array<[RegExp, string]> = [
  // a scratch repo keeps its repo-relative tail (/REPO/hello.txt) so briefing tests see real file names
  [new RegExp(`/private/tmp/claude-${UID}/[^"]*?/scratchpad/spike-repo(?=[/"])`, 'g'), '/REPO'],
  [new RegExp(`/private/tmp/claude-${UID}/[^"]*`, 'g'), '/REPO'],
  [new RegExp(`${esc(HOME)}/[^"]*?/spike/repo0b`, 'g'), '/REPO'],
  [new RegExp(esc(HOME), 'g'), '/HOME'],
  [new RegExp(`${esc(HOME.replace(/[/.]/g, '-'))}-[A-Za-z0-9-]*`, 'g'), '-HOME-x'],
  [new RegExp(`-private-tmp-claude-${UID}-[A-Za-z0-9-]*`, 'g'), '-REPO'],
  [new RegExp(esc(USER).replace(/\\\./g, '[.-]'), 'g'), 'user'],
  [/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, ZERO],
];

export function sanitize(text: string): string {
  return RULES.reduce((t, [re, to]) => t.replace(re, to), text);
}

mkdirSync(OUT, { recursive: true });
let n = 0;
for (const f of readdirSync(SRC).sort()) {
  if (!f.endsWith('.json') || f.endsWith('-projhook.json')) continue;
  const raw = JSON.parse(readFileSync(join(SRC, f), 'utf8')) as { body?: { hook_event_name?: string } };
  const event = raw.body?.hook_event_name;
  if (!event) continue;
  const num = f.split('-')[0];
  writeFileSync(join(OUT, `${num}-${event}.json`), sanitize(JSON.stringify(raw.body, null, 2)) + '\n');
  n++;
}
console.log(`sanitised ${n} fixtures`);
