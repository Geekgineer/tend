import type { TendEvent } from './events.ts';

export type Need = 'permission' | 'question' | 'plan' | 'trust';

export type SessionState = {
  status: 'starting' | 'working' | 'needs_you' | 'idle' | 'ended';
  need?: Need;
  since: number;
  lastTool?: string;
};

export type NotifyIntent = { sessionId: string; title: string; body: string };

export function initialState(now: number): SessionState {
  return { status: 'starting', since: now };
}

const PROMPT_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

function needForTool(tool: string | undefined): Need {
  if (tool === 'AskUserQuestion') return 'question';
  if (tool === 'ExitPlanMode') return 'plan';
  return 'permission';
}

function move(s: SessionState, status: SessionState['status'], need: Need | undefined, e: TendEvent): SessionState {
  const next: SessionState = { status, since: s.status === status && s.need === need ? s.since : e.ts };
  if (need !== undefined) next.need = need;
  if (s.lastTool !== undefined) next.lastTool = s.lastTool;
  return next;
}

const TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
/** A tool event from a sub-agent (it carries an agent_id), not from Claude's own turn. */
const fromSubagent = (e: TendEvent): boolean =>
  typeof e.data === 'object' && e.data !== null && typeof (e.data as { agent_id?: unknown }).agent_id === 'string';

export function reduce(s: SessionState, e: TendEvent): SessionState {
  if (e.kind === 'resumed') return { status: 'starting', since: e.ts };
  if (s.status === 'ended') return s;
  // Outside a turn, a sub-agent's tools don't make Claude busy: 2.1.318's prompt suggestions run their command ahead
  // after Stop (no Stop follows them), which used to leave the session "working" until the screen check caught it.
  // (idle only: a sub-agent's tool after its own permission was answered in the terminal must still clear needs_you)
  if (s.status === 'idle' && TOOL_EVENTS.has(e.kind) && fromSubagent(e)) return s;
  switch (e.kind) {
    case 'trust_prompt':
      return s.status === 'starting' ? move(s, 'needs_you', 'trust', e) : s;
    case 'pane_idle': // hooks were lost (Tend was down): Claude's screen shows it waiting at its prompt
      return (s.status === 'working' || s.status === 'needs_you') && s.need !== 'trust' ? move(s, 'idle', undefined, e) : s;
    case 'pane_dialog': // a permission dialog Tend never heard about: answer it in the terminal
      return s.status === 'working' ? move(s, 'needs_you', 'permission', e) : s;
    case 'trust_done':
      // Claude sends no SessionStart after the dialog is accepted: it is at its prompt now
      return s.status === 'needs_you' && s.need === 'trust' ? move(s, 'idle', undefined, e) : s;
    case 'decided': // answered on a card: Claude carries on
      return s.status === 'needs_you' ? move(s, 'working', undefined, e) : s;
    case 'SessionStart':
      return s.status === 'starting' ? move(s, 'idle', undefined, e) : s;
    case 'PreToolUse': {
      const keep = s.status === 'needs_you' && e.tool !== undefined && PROMPT_TOOLS.has(e.tool);
      const next = keep ? move(s, 'needs_you', s.need, e) : move(s, 'working', undefined, e);
      if (e.tool !== undefined) next.lastTool = e.tool;
      return next;
    }
    case 'PostToolUseFailure': {
      // Esc during a tool: Claude stops and waits at its prompt (no Stop follows)
      const d = (typeof e.data === 'object' && e.data !== null ? e.data : {}) as { is_interrupt?: unknown };
      if (d.is_interrupt === true || d.is_interrupt === 'True') return move(s, 'idle', undefined, e);
      return move(s, 'working', undefined, e);
    }
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return move(s, 'working', undefined, e);
    case 'PermissionRequest': {
      const next = move(s, 'needs_you', needForTool(e.tool), e);
      if (e.tool !== undefined) next.lastTool = e.tool; // the notification names the tool asked about
      return next;
    }
    case 'Stop':
      return move(s, 'idle', undefined, e);
    case 'SessionEnd':
    case 'pane_exit':
      return move(s, 'ended', undefined, e);
    case 'Notification': {
      // Claude's own "waiting for your input" (60 s at its prompt): a Stop lost while Tend was down ends here
      const d = (typeof e.data === 'object' && e.data !== null ? e.data : {}) as { notification_type?: unknown };
      return d.notification_type === 'idle_prompt' && s.status === 'working' ? move(s, 'idle', undefined, e) : s;
    }
    default:
      return s; // SubagentStop
  }
}

export function notifyFor(
  prev: SessionState,
  next: SessionState,
  sessionId: string,
  sessionName: string,
): NotifyIntent | null {
  if (next.status !== 'needs_you') return null;
  if (prev.status === 'needs_you' && prev.need === next.need) return null;
  const body =
    next.need === 'question'
      ? 'Has a question'
      : next.need === 'plan'
        ? 'Plan ready for approval'
        : next.need === 'trust'
          ? 'Asks you to trust the folder'
          : `Wants permission: ${next.lastTool ?? 'a tool'}`;
  return { sessionId, title: `${sessionName} needs you`, body };
}
