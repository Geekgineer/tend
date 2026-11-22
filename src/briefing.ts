import { realpathSync } from 'node:fs';
import type { TendEvent } from './events.ts';

export type Briefing = {
  goal: string | null;
  instructions: { ts: number; text: string }[];
  done: { ts: number; text: string; files: string[] }[];
  files: string[];
  working: string[];
};

const MAX_TEXT = 1000;
const MAX_ENTRIES = 20;
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

function field(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined;
}

function relativise(path: string, roots: string[]): string | null {
  for (const r of roots) {
    const base = r.endsWith('/') ? r : `${r}/`;
    if (!path.startsWith(base)) continue;
    const rel = path.slice(base.length);
    if (rel === '' || rel === '.tend' || rel.startsWith('.tend/')) return null;
    return rel;
  }
  return null;
}

export function buildBriefing(events: TendEvent[], root: string): Briefing {
  const roots = [root];
  try {
    const real = realpathSync(root);
    if (real !== root) roots.push(real);
  } catch {
    // root may not exist (unit tests)
  }

  let goal: string | null = null;
  const instructions: Briefing['instructions'] = [];
  const done: Briefing['done'] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  let working: string[] = [];

  for (const e of events) {
    if (e.kind === 'UserPromptSubmit') {
      const p = field(e.data, 'prompt');
      if (typeof p !== 'string') continue;
      if (goal === null) goal = clip(p);
      else instructions.push({ ts: e.ts, text: clip(p) });
    } else if (e.kind === 'PostToolUse' && e.tool !== undefined && EDIT_TOOLS.has(e.tool)) {
      const input = field(e.data, 'tool_input');
      const p = field(input, e.tool === 'NotebookEdit' ? 'notebook_path' : 'file_path');
      if (typeof p !== 'string') continue;
      const rel = relativise(p, roots);
      if (rel === null) continue;
      if (!seen.has(rel)) {
        seen.add(rel);
        files.push(rel);
      }
      if (!working.includes(rel)) working.push(rel);
    } else if (e.kind === 'Stop') {
      const m = field(e.data, 'last_assistant_message');
      done.push({ ts: e.ts, text: typeof m === 'string' ? clip(m) : '', files: working });
      working = [];
    }
  }

  return {
    goal,
    instructions: instructions.slice(-MAX_ENTRIES),
    done: done.slice(-MAX_ENTRIES),
    files,
    working,
  };
}
