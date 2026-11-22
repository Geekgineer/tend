export type HookKind =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionEnd'
  | 'SessionStart';

export type TendEvent = {
  ts: number;
  sessionId: string;
  kind: HookKind | 'pane_exit' | 'resumed' | 'trust_prompt' | 'trust_done' | 'decided' | 'pane_idle' | 'pane_dialog';
  tool?: string;
  claudeSessionId?: string;
  data: unknown;
};

const KINDS: ReadonlySet<string> = new Set<HookKind>([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd',
  'SessionStart',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude session ids reach claude's argv and file names: only a UUID is ever accepted. */
export const isClaudeId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function normalize(body: unknown, sessionId: string, now: number): TendEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const name = b.hook_event_name;
  if (typeof name !== 'string' || !KINDS.has(name)) return null;
  const ev: TendEvent = { ts: now, sessionId, kind: name as HookKind, data: body };
  if (typeof b.tool_name === 'string') ev.tool = b.tool_name;
  if (isClaudeId(b.session_id)) ev.claudeSessionId = b.session_id;
  return ev;
}
