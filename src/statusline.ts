import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Tend's --settings statusLine wins over the user's (Phase 0b), so Tend's wrapper runs the user's own
// effective statusLine itself: project local > project shared > the account's user settings.

/** The user's own statusLine command for this project and account, or null. Never Tend's own wrapper. */
export function userStatusLine(projectDir: string | null, configDir: string): string | null {
  const files = [
    ...(projectDir ? [join(projectDir, '.claude', 'settings.local.json'), join(projectDir, '.claude', 'settings.json')] : []),
    join(configDir, 'settings.json'),
  ];
  const read = files.map((f) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  });
  // the user turned commands from settings off: run none of theirs
  if (read.some((j) => j?.disableAllHooks === true)) return null;
  for (const j of read) {
    if (!j) continue;
    const sl = (j as { statusLine?: { type?: unknown; command?: unknown } }).statusLine;
    if (!sl) continue;
    if (sl.type === 'command' && typeof sl.command === 'string' && sl.command.trim() && !sl.command.includes('tend-statusline')) return sl.command;
    return null; // the most specific statusLine decides, even if it isn't a command
  }
  return null;
}
