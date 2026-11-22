import { randomBytes } from 'node:crypto';
import { UserError } from './errors.ts';
import { classify } from './risk.ts';
import type { Risk, RiskRule } from './risk.ts';

// The permission broker. Claude Code 2.1.312 (Phase 0): a held PermissionRequest http hook keeps Claude's
// own dialog open; a hook answer dismisses it; an answer in the terminal makes Claude close the request.
// So: first answer wins, and a request that closes without an answer is never an allow.

export type DecisionKind = 'permission' | 'question' | 'plan';
export type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };

/** What the UI needs to show a card. Only display fields, never the raw hook body. */
export type DecisionView = {
  id: string;
  kind: DecisionKind;
  tool: string;
  createdAt: number;
  /** permission: the command / file / url being asked about */
  command?: string;
  description?: string;
  filePath?: string;
  url?: string;
  risk?: Risk;
  /** Claude offered a safe "always" (session-scoped: accept edits, or this exact rule) */
  canAlways?: boolean;
  /** What "always" grants, shown on its button */
  alwaysLabel?: string;
  questions?: Question[];
  /** questions Tend can't answer (multi-select): the card sends you to the terminal */
  terminalOnly?: boolean;
  plan?: string;
};

export type Answer =
  | { action: 'allow'; confirm?: boolean }
  | { action: 'always' }
  | { action: 'deny'; message?: string }
  | { action: 'answers'; answers: Record<string, string> }
  | { action: 'approve' };

/** The held hook connection: `reply` writes the JSON answer; false if the request is already gone. */
export type Held = { reply(body: unknown): boolean };

/** An empty hook answer: no decision (Claude's own dialog decides, if it's still waiting at all). */
export const NO_DECISION = {};

type Pending = { view: DecisionView; sessionId: string; held: Held; input: Record<string, unknown>; suggestions: unknown[] };

const MAX_TEXT = 20_000;
/** Held requests per session; more are answered at once with no decision (Claude's dialog decides). */
export const MAX_PENDING = 20;

/**
 * The "always" Tend can offer: only Claude's own suggestions of a known-safe shape, all scoped to this
 * session: accept edits, or allow rules with no wildcard. Anything wider (a `Bash(git push:*)` prefix, a
 * rule saved to project settings, extra folders) stays in Claude's dialog. Returns the button label or null.
 */
export function safeAlways(suggestions: unknown[]): string | null {
  if (suggestions.length === 0) return null;
  const labels: string[] = [];
  for (const raw of suggestions) {
    if (typeof raw !== 'object' || raw === null) return null;
    const x = raw as Record<string, unknown>;
    if (x.destination !== 'session') return null;
    if (x.type === 'setMode' && x.mode === 'acceptEdits') labels.push('Allow edits this session');
    else if (x.type === 'addRules' && x.behavior === 'allow' && Array.isArray(x.rules) && x.rules.length > 0) {
      for (const r of x.rules) {
        const rule = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
        if (typeof rule.toolName !== 'string') return null;
        // exact content only: no wildcard, and never a whole-tool rule (no content = every call of that tool)
        if (typeof rule.ruleContent !== 'string' || rule.ruleContent.trim() === '' || /[*?]/.test(rule.ruleContent)) return null;
        labels.push(`Always allow ${rule.toolName}(${rule.ruleContent}) this session`);
      }
    } else return null;
  }
  return labels.join(' · ');
}
const str = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);

function questionsOf(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) return [];
  return input.questions.flatMap((q) => {
    if (typeof q !== 'object' || q === null) return [];
    const r = q as Record<string, unknown>;
    // the full text: answers are keyed by it (the card shows it; long ones scroll)
    const question = str(r.question);
    if (!question || !Array.isArray(r.options)) return [];
    const options = r.options.flatMap((o) => {
      const x = (typeof o === 'object' && o !== null ? o : {}) as Record<string, unknown>;
      const label = str(x.label, 500);
      return label ? [{ label, description: str(x.description, 2000) ?? '' }] : [];
    });
    return options.length ? [{ question, header: str(r.header, 200) ?? '', multiSelect: r.multiSelect === true, options }] : [];
  });
}

/** Build the card for one PermissionRequest body; `root` is the session folder (for the risk of edits). */
export function decisionOf(body: Record<string, unknown>, root: string, rules: RiskRule[], now: number): Omit<Pending, 'held' | 'sessionId'> {
  const tool = typeof body.tool_name === 'string' ? body.tool_name : 'unknown';
  const input = (typeof body.tool_input === 'object' && body.tool_input !== null ? body.tool_input : {}) as Record<string, unknown>;
  const suggestions = Array.isArray(body.permission_suggestions) ? body.permission_suggestions : [];
  const id = randomBytes(8).toString('hex');
  if (tool === 'AskUserQuestion') {
    const questions = questionsOf(input);
    const terminalOnly = questions.length === 0 || questions.some((q) => q.multiSelect);
    return { view: { id, kind: 'question', tool, createdAt: now, questions, ...(terminalOnly ? { terminalOnly } : {}) }, input, suggestions: [] };
  }
  if (tool === 'ExitPlanMode') {
    return { view: { id, kind: 'plan', tool, createdAt: now, plan: str(input.plan) ?? '' }, input, suggestions: [] };
  }
  const view: DecisionView = { id, kind: 'permission', tool, createdAt: now, risk: classify(tool, input, root, rules) };
  const command = str(input.command);
  const description = str(input.description, 2000);
  const filePath = str(input.file_path, 4096) ?? str(input.notebook_path, 4096);
  const url = str(input.url, 4096) ?? str(input.query, 2000);
  if (command !== undefined) view.command = command;
  if (description !== undefined) view.description = description;
  if (filePath !== undefined) view.filePath = filePath;
  if (url !== undefined) view.url = url;
  const always = view.risk!.level === 'high' ? null : safeAlways(suggestions);
  if (always) {
    view.canAlways = true;
    view.alwaysLabel = always;
  }
  return { view, input, suggestions };
}

const out = (decision: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });

/** The exact hook answer for a card answer (the shapes verified in Phase 0). Throws UserError when it doesn't fit. */
export function replyFor(p: Pick<Pending, 'view' | 'input' | 'suggestions'>, a: Answer): unknown {
  const { view } = p;
  if (a.action === 'deny') return out({ behavior: 'deny', message: a.message?.trim() ? a.message.trim().slice(0, 2000) : 'Denied in Tend' });
  if (view.kind === 'permission') {
    if (a.action === 'allow') {
      if (view.risk?.level === 'high' && a.confirm !== true) throw new UserError('High-risk requests need a confirmed allow.');
      return out({ behavior: 'allow' });
    }
    if (a.action === 'always') {
      if (!view.canAlways) throw new UserError(view.risk?.level === 'high' ? 'High-risk requests are never always allowed.' : 'No session-only "always" is available here: answer in the terminal for wider rules.');
      return out({ behavior: 'allow', updatedPermissions: p.suggestions });
    }
  }
  if (view.kind === 'question' && a.action === 'answers') {
    if (view.terminalOnly) throw new UserError('Answer this question in the terminal.');
    const qs = view.questions ?? [];
    const answers: Record<string, string> = {};
    for (const q of qs) {
      const label = a.answers[q.question];
      if (!q.options.some((o) => o.label === label)) throw new UserError(`Pick an option for "${q.question.slice(0, 80)}".`);
      answers[q.question] = label!;
    }
    return out({ behavior: 'allow', updatedInput: { ...p.input, answers } });
  }
  if (view.kind === 'plan' && a.action === 'approve') return out({ behavior: 'allow', updatedInput: p.input });
  throw new UserError('That answer does not fit this request.');
}

export type Broker = {
  /** Hold a PermissionRequest; returns the decision id, or null when the session already has MAX_PENDING. */
  hold(sessionId: string, body: Record<string, unknown>, root: string, held: Held): string | null;
  /** The held request closed (answered in the terminal, Esc, IDE, timeout): drop it. No answer is sent. */
  closed(id: string): void;
  /** Answer from a card. Throws UserError 'Already answered' if the request is gone. */
  answer(sessionId: string, id: string, a: Answer): void;
  pendingFor(sessionId: string): DecisionView[];
  /** The session ended or was archived: forget its decisions (their requests are gone with Claude). */
  drop(sessionId: string): void;
  /**
   * Claude moved on without closing the held request (2.1.312 keeps it open after an answer in the
   * terminal). `tool`+`input` settles the matching request (its tool ran); without them, every request of
   * the session (a Stop or a new prompt: nothing in that turn is still waiting). Each gets an empty answer.
   */
  settle(sessionId: string, match?: { tool: string; input: unknown }): void;
};

export class GoneError extends UserError {}

/** Structural equality for JSON values (hook tool inputs). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function createBroker(o: { rules: () => RiskRule[]; now?: () => number; onChange: (sessionId: string) => void }): Broker {
  const now = o.now ?? Date.now;
  const pending = new Map<string, Pending>();
  const take = (id: string): Pending | undefined => {
    const p = pending.get(id);
    if (p) pending.delete(id);
    return p;
  };
  return {
    hold(sessionId, body, root, held) {
      if ([...pending.values()].filter((p) => p.sessionId === sessionId).length >= MAX_PENDING) return null;
      const d = decisionOf(body, root, o.rules(), now());
      pending.set(d.view.id, { ...d, sessionId, held });
      o.onChange(sessionId);
      return d.view.id;
    },
    closed(id) {
      const p = take(id);
      if (p) o.onChange(p.sessionId);
    },
    answer(sessionId, id, a) {
      const p = pending.get(id);
      if (!p || p.sessionId !== sessionId) throw new GoneError('Already answered (in the terminal, or the request is gone).');
      const body = replyFor(p, a); // validates before anything is sent
      take(id);
      const sent = p.held.reply(body);
      o.onChange(sessionId);
      if (!sent) throw new GoneError('Already answered (in the terminal, or the request is gone).');
    },
    pendingFor(sessionId) {
      return [...pending.values()].filter((p) => p.sessionId === sessionId).map((p) => p.view).sort((a, b) => a.createdAt - b.createdAt);
    },
    drop(sessionId) {
      let changed = false;
      for (const [id, p] of pending) {
        if (p.sessionId !== sessionId) continue;
        pending.delete(id);
        p.held.reply(NO_DECISION);
        changed = true;
      }
      if (changed) o.onChange(sessionId);
    },
    settle(sessionId, match) {
      let changed = false;
      for (const [id, p] of pending) {
        if (p.sessionId !== sessionId) continue;
        if (match && match.tool !== p.view.tool) continue;
        // a question's or plan's input changes once answered (answers added): match those by tool only
        if (match && p.view.kind === 'permission' && !sameJson(match.input, p.input)) continue;
        pending.delete(id);
        p.held.reply(NO_DECISION);
        changed = true;
        if (match) break; // one tool run settles one request
      }
      if (changed) o.onChange(sessionId);
    },
  };
}
