import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalize } from '../../src/events.ts';
import type { HookKind, TendEvent } from '../../src/events.ts';
import { initialState, notifyFor, reduce } from '../../src/state.ts';
import type { NotifyIntent, SessionState } from '../../src/state.ts';

const fixture = (n: string): TendEvent => {
  const body = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'fixtures', 'phase0', n), 'utf8'),
  ) as unknown;
  const ev = normalize(body, 'abcd1234', 1000);
  assert.ok(ev, `fixture ${n} normalises`);
  return ev;
};

const ev = (kind: TendEvent['kind'], tool?: string, ts = 1000): TendEvent => {
  const e: TendEvent = { ts, sessionId: 'abcd1234', kind, data: {} };
  if (tool !== undefined) e.tool = tool;
  return e;
};

function replay(events: TendEvent[], start: SessionState = initialState(0)) {
  let s = start;
  const intents: NotifyIntent[] = [];
  for (const e of events) {
    const next = reduce(s, e);
    const i = notifyFor(s, next, e.sessionId, 'demo');
    if (i) intents.push(i);
    s = next;
  }
  return { state: s, intents };
}

test('initialState starts in starting', () => {
  assert.deepEqual(initialState(5), { status: 'starting', since: 5 });
});

test('fixtures 021..024 end in needs_you/question', () => {
  const evs = ['021-UserPromptSubmit', '022-PreToolUse', '023-PermissionRequest', '024-Notification'].map((n) =>
    fixture(`${n}.json`),
  );
  const { state, intents } = replay(evs);
  assert.equal(state.status, 'needs_you');
  assert.equal(state.need, 'question');
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.body, 'Has a question');
  assert.equal(intents[0]?.title, 'demo needs you');
});

test('Write permission sequence ends idle with exactly one intent', () => {
  const evs = [
    '005-PermissionRequest',
    '006-Notification',
    '007-PostToolUse',
    '009-Stop',
    '011-SubagentStop',
  ].map((n) => fixture(`${n}.json`));
  const { state, intents } = replay(evs);
  assert.equal(state.status, 'idle');
  assert.equal(state.need, undefined);
  assert.equal(intents.length, 1);
});

test('Notification and SubagentStop do not change state', () => {
  const s = reduce(initialState(0), ev('UserPromptSubmit', undefined, 10));
  assert.deepEqual(reduce(s, ev('Notification', undefined, 20)), s);
  assert.deepEqual(reduce(s, ev('SubagentStop', undefined, 20)), s);
});

test('after Stop, a sub-agent running a tool (a prompt suggestion) leaves the session idle; inside a turn it stays working', () => {
  const sub = (kind: TendEvent['kind'], ts: number): TendEvent => ({ ts, sessionId: 'abcd1234', kind, tool: 'Bash', data: { agent_id: 'a0143099fddbcd5f7' } });
  // the soak's real sequence (2.1.318): Stop, then the suggestion's PreToolUse Bash + SubagentStop, and no Stop after
  let s = reduce(initialState(0), ev('UserPromptSubmit', undefined, 10));
  s = reduce(s, ev('Stop', undefined, 20));
  for (const e of [sub('PreToolUse', 30), sub('PostToolUse', 31), sub('SubagentStop', 32)]) s = reduce(s, e);
  assert.equal(s.status, 'idle');
  assert.equal(s.since, 20);
  // a sub-agent's tools during a turn: still working; Claude's own tools after Stop: working again
  let t = reduce(initialState(0), ev('UserPromptSubmit', undefined, 10));
  t = reduce(t, sub('PreToolUse', 11));
  assert.equal(t.status, 'working');
  assert.equal(reduce(reduce(t, ev('Stop', undefined, 20)), ev('PreToolUse', 'Bash', 21)).status, 'working');
  // a sub-agent that needs permission still asks the person; answered in the terminal, its tool runs: working again
  const asked = reduce(t, sub('PermissionRequest', 40));
  assert.equal(asked.status, 'needs_you');
  assert.equal(reduce(asked, sub('PostToolUse', 41)).status, 'working');
});

test('Claude\'s "waiting for your input" notification ends a turn whose Stop was lost (Tend was restarting)', () => {
  const idle = (ts: number): TendEvent => ({ ts, sessionId: 'abcd1234', kind: 'Notification', data: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' } });
  const s = reduce(initialState(0), ev('UserPromptSubmit', undefined, 10)); // ...and the Stop never arrived
  assert.deepEqual(reduce(s, idle(70)), { status: 'idle', since: 70 });
  // other notifications change nothing; and it never overrides a question or a permission
  assert.deepEqual(reduce(s, { ...idle(70), data: { notification_type: 'permission_prompt' } }), s);
  const asking = reduce(s, ev('PermissionRequest', 'Bash', 20));
  assert.deepEqual(reduce(asking, idle(80)), asking);
});

test('PermissionRequest need depends on tool', () => {
  const s0 = initialState(0);
  assert.equal(reduce(s0, ev('PermissionRequest', 'ExitPlanMode')).need, 'plan');
  assert.equal(reduce(s0, ev('PermissionRequest', 'AskUserQuestion')).need, 'question');
  assert.equal(reduce(s0, ev('PermissionRequest', 'Bash')).need, 'permission');
  assert.equal(reduce(s0, ev('PermissionRequest')).need, 'permission');
});

test('PreToolUse for AskUserQuestion/ExitPlanMode keeps an existing need; others clear', () => {
  const needy = reduce(initialState(0), ev('PermissionRequest', 'ExitPlanMode', 5));
  const kept = reduce(needy, ev('PreToolUse', 'ExitPlanMode', 9));
  assert.equal(kept.status, 'needs_you');
  assert.equal(kept.need, 'plan');
  assert.equal(kept.since, 5);
  assert.equal(kept.lastTool, 'ExitPlanMode');
  const cleared = reduce(needy, ev('PreToolUse', 'Bash', 9));
  assert.equal(cleared.status, 'working');
  assert.equal(cleared.need, undefined);
  assert.equal(cleared.since, 9);
  // without an existing need it just goes working
  assert.equal(reduce(initialState(0), ev('PreToolUse', 'AskUserQuestion')).status, 'working');
});

test('since only changes when status or need changes; lastTool tracks PreToolUse', () => {
  let s = reduce(initialState(0), ev('UserPromptSubmit', undefined, 10));
  assert.equal(s.since, 10);
  s = reduce(s, ev('PreToolUse', 'Read', 20));
  assert.equal(s.since, 10);
  assert.equal(s.lastTool, 'Read');
  s = reduce(s, ev('PostToolUse', 'Read', 30));
  assert.equal(s.since, 10);
  assert.equal(s.lastTool, 'Read');
  s = reduce(s, ev('Stop', undefined, 40));
  assert.equal(s.status, 'idle');
  assert.equal(s.since, 40);
});

test('SessionEnd and pane_exit end the session; ended is terminal', () => {
  const a = replay([ev('SessionEnd'), ev('PreToolUse', 'Bash')]).state;
  assert.equal(a.status, 'ended');
  const b = replay([ev('pane_exit'), ev('PermissionRequest', 'Bash'), ev('UserPromptSubmit')]).state;
  assert.equal(b.status, 'ended');
  assert.equal(b.need, undefined);
});

test('notifyFor: bodies and re-notify on need change', () => {
  const working: SessionState = { status: 'working', since: 1, lastTool: 'Bash' };
  const perm: SessionState = { status: 'needs_you', need: 'permission', since: 2, lastTool: 'Bash' };
  const plan: SessionState = { status: 'needs_you', need: 'plan', since: 3, lastTool: 'Bash' };
  assert.deepEqual(notifyFor(working, perm, 'abcd1234', 'api'), {
    sessionId: 'abcd1234',
    title: 'api needs you',
    body: 'Wants permission: Bash',
  });
  assert.equal(notifyFor(perm, perm, 'abcd1234', 'api'), null);
  assert.equal(notifyFor(perm, plan, 'abcd1234', 'api')?.body, 'Plan ready for approval');
  assert.equal(notifyFor(plan, working, 'abcd1234', 'api'), null);
});

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: invariants over 500 seeded random sequences', () => {
  const kinds: Array<HookKind | 'pane_exit'> = [
    'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
    'Notification', 'Stop', 'SubagentStop', 'SessionEnd', 'pane_exit',
  ];
  const tools = ['Bash', 'Write', 'AskUserQuestion', 'ExitPlanMode', undefined];
  const rnd = mulberry32(0xc0ffee);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  for (let n = 0; n < 500; n++) {
    const len = 1 + Math.floor(rnd() * 40);
    let s = initialState(0);
    let permissionRequests = 0;
    let intents = 0;
    let ended = false;
    for (let i = 0; i < len; i++) {
      const e = ev(pick(kinds), pick(tools), i + 1);
      if (e.kind === 'PermissionRequest') permissionRequests++;
      const next = reduce(s, e);
      if (notifyFor(s, next, e.sessionId, 'p')) intents++;
      assert.equal(next.need !== undefined, next.status === 'needs_you', `need iff needs_you (seq ${n})`);
      if (ended) assert.deepEqual(next, s, 'ended is absorbing');
      if (next.status === 'ended') ended = true;
      s = next;
    }
    assert.ok(intents <= permissionRequests, `intents ${intents} <= PermissionRequests ${permissionRequests}`);
  }
});

test('PermissionRequest names its own tool, not the previous PreToolUse', () => {
  const { state, intents } = replay([ev('PreToolUse', 'Bash'), ev('PostToolUse'), ev('PermissionRequest', 'Write')]);
  assert.equal(state.lastTool, 'Write');
  assert.equal(intents.length, 1);
  assert.equal(intents[0]!.body, 'Wants permission: Write');
  // a PermissionRequest without a tool keeps what was known
  assert.equal(reduce({ status: 'working', since: 0, lastTool: 'Edit' }, ev('PermissionRequest')).lastTool, 'Edit');
});

test('resumed resets an ended session to starting', () => {
  assert.deepEqual(reduce({ status: 'ended', since: 1 }, ev('resumed', undefined, 5)), { status: 'starting', since: 5 });
});

test('fold [Stop, SessionEnd, resumed, UserPromptSubmit] ends working', () => {
  const { state: s } = replay([ev('Stop', undefined, 1), ev('SessionEnd', undefined, 2), ev('resumed', undefined, 3), ev('UserPromptSubmit', undefined, 4)]);
  assert.equal(s.status, 'working');
});

test('trust_prompt on starting goes to needs_you/trust; trust_done goes to idle; trust_prompt on working is ignored', () => {
  const starting = initialState(0);
  const asking = reduce(starting, ev('trust_prompt', undefined, 5));
  assert.deepEqual(asking, { status: 'needs_you', need: 'trust', since: 5 });
  assert.deepEqual(reduce(asking, ev('trust_done', undefined, 6)), { status: 'idle', since: 6 });
  const working: SessionState = { status: 'working', since: 2 };
  assert.equal(reduce(working, ev('trust_prompt', undefined, 7)), working);
  assert.equal(reduce(working, ev('trust_done', undefined, 7)), working);
  assert.equal(reduce(starting, ev('trust_done', undefined, 7)), starting);
  assert.equal(reduce(asking, ev('trust_prompt', undefined, 7)), asking);
});

test('SessionStart moves starting to idle and changes nothing else', () => {
  assert.deepEqual(reduce(initialState(0), ev('SessionStart', undefined, 4)), { status: 'idle', since: 4 });
  const working: SessionState = { status: 'working', since: 2 };
  assert.equal(reduce(working, ev('SessionStart', undefined, 5)), working);
  const asking: SessionState = { status: 'needs_you', need: 'trust', since: 3 };
  assert.equal(reduce(asking, ev('SessionStart', undefined, 5)), asking);
});

test('a real hook event leaves needs_you/trust like any other needs-you state', () => {
  const asking: SessionState = { status: 'needs_you', need: 'trust', since: 5 };
  assert.equal(reduce(asking, ev('PreToolUse', 'Bash', 6)).status, 'working');
  assert.equal(reduce(asking, ev('Stop', undefined, 6)).status, 'idle');
});

test('notifyFor gives "Asks you to trust the folder" for need trust', () => {
  const next: SessionState = { status: 'needs_you', need: 'trust', since: 5 };
  assert.deepEqual(notifyFor(initialState(0), next, 'abcd1234', 'demo'), { sessionId: 'abcd1234', title: 'demo needs you', body: 'Asks you to trust the folder' });
});
