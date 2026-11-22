import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBroker, decisionOf, GoneError, MAX_PENDING, replyFor, safeAlways } from '../../src/decisions.ts';
import { DEFAULT_RULES } from '../../src/risk.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/phase0/${n}`, import.meta.url), 'utf8'));
const WRITE = fx('005-PermissionRequest.json');
const ASK = fx('023-PermissionRequest.json');
const PLAN = fx('114-PermissionRequest.json');
const bash = (command: string) => ({ ...WRITE, tool_name: 'Bash', tool_input: { command, description: 'd' }, permission_suggestions: [{ type: 'addRules' }] });

const held = () => {
  const sent: unknown[] = [];
  let open = true;
  return { sent, close: () => (open = false), h: { reply: (b: unknown) => (open ? (sent.push(b), true) : false) } };
};
const broker = (changes: string[] = []) => createBroker({ rules: () => DEFAULT_RULES, now: () => 1000, onChange: (s) => changes.push(s) });

test('a Write permission becomes a low-risk card that may be always allowed with Claude\'s own suggestion', () => {
  const d = decisionOf(WRITE, '/REPO', DEFAULT_RULES, 5);
  assert.equal(d.view.kind, 'permission');
  assert.equal(d.view.filePath, '/REPO/hello.txt');
  assert.deepEqual(d.view.risk, { level: 'low', rule: 'Edits a file in the session folder' });
  assert.equal(d.view.canAlways, true);
  assert.equal(d.view.alwaysLabel, 'Allow edits this session');
  assert.deepEqual(replyFor(d, { action: 'allow' }), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(replyFor(d, { action: 'always' }), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } },
  });
  assert.deepEqual(replyFor(d, { action: 'deny' }), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied in Tend' } } });
  assert.deepEqual((replyFor(d, { action: 'deny', message: ' use b.txt ' }) as any).hookSpecificOutput.decision.message, 'use b.txt');
  assert.throws(() => replyFor(d, { action: 'approve' }), /does not fit/);
});

test('high risk never offers or accepts "always"', () => {
  const d = decisionOf(bash('rm -rf /'), '/REPO', DEFAULT_RULES, 5);
  assert.equal(d.view.risk!.level, 'high');
  assert.equal(d.view.canAlways, undefined);
  assert.throws(() => replyFor(d, { action: 'always' }), /never always allowed/);
  assert.throws(() => replyFor(d, { action: 'allow' }), /confirmed allow/);
  assert.equal((replyFor(d, { action: 'allow', confirm: true }) as any).hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(d.view.command, 'rm -rf /');
});

test('a question card answers with updatedInput.answers keyed by the question text', () => {
  const d = decisionOf(ASK, '/REPO', DEFAULT_RULES, 5);
  assert.equal(d.view.kind, 'question');
  const q = d.view.questions![0]!;
  assert.ok(q.options.length >= 2);
  const r = replyFor(d, { action: 'answers', answers: { [q.question]: q.options[1]!.label } }) as any;
  assert.equal(r.hookSpecificOutput.decision.behavior, 'allow');
  assert.deepEqual(r.hookSpecificOutput.decision.updatedInput.answers, { [q.question]: q.options[1]!.label });
  assert.deepEqual(r.hookSpecificOutput.decision.updatedInput.questions, ASK.tool_input.questions);
  assert.throws(() => replyFor(d, { action: 'answers', answers: { [q.question]: 'Purple' } }), /Pick an option/);
  assert.throws(() => replyFor(d, { action: 'allow' }), /does not fit/);
});

test('multi-select questions are terminal-only', () => {
  const multi = { ...ASK, tool_input: { questions: [{ ...ASK.tool_input.questions[0], multiSelect: true }] } };
  const d = decisionOf(multi, '/REPO', DEFAULT_RULES, 5);
  assert.equal(d.view.terminalOnly, true);
  assert.throws(() => replyFor(d, { action: 'answers', answers: {} }), /in the terminal/);
});

test('plan approval echoes the original tool_input', () => {
  const d = decisionOf(PLAN, '/REPO', DEFAULT_RULES, 5);
  assert.equal(d.view.kind, 'plan');
  assert.match(d.view.plan!, /plan\.txt/);
  assert.deepEqual(replyFor(d, { action: 'approve' }), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: PLAN.tool_input } },
  });
});

test('first answer wins: a closed request is dropped and a late card answer is Gone, never an allow', () => {
  const changes: string[] = [];
  const b = broker(changes);
  const x = held();
  const id = b.hold('aaaa0001', WRITE, '/REPO', x.h)!;
  assert.equal(b.pendingFor('aaaa0001').length, 1);
  x.close();
  b.closed(id);
  assert.deepEqual(b.pendingFor('aaaa0001'), []);
  assert.throws(() => b.answer('aaaa0001', id, { action: 'allow' }), GoneError);
  assert.deepEqual(x.sent, []);
  assert.deepEqual(changes, ['aaaa0001', 'aaaa0001']);
});

test('answers go only to the matching session and request; a bad answer sends nothing and keeps the card', () => {
  const b = broker();
  const x = held();
  const y = held();
  const a = b.hold('aaaa0001', WRITE, '/REPO', x.h)!;
  const c = b.hold('bbbb0002', bash('rm -rf x'), '/REPO', y.h)!;
  assert.throws(() => b.answer('bbbb0002', a, { action: 'allow' }), GoneError); // wrong session
  assert.throws(() => b.answer('bbbb0002', c, { action: 'always' }), /never always/);
  assert.equal(b.pendingFor('bbbb0002').length, 1);
  b.answer('aaaa0001', a, { action: 'deny' });
  b.answer('bbbb0002', c, { action: 'allow', confirm: true });
  assert.equal((x.sent[0] as any).hookSpecificOutput.decision.behavior, 'deny');
  assert.equal((y.sent[0] as any).hookSpecificOutput.decision.behavior, 'allow');
  assert.throws(() => b.answer('aaaa0001', a, { action: 'allow' }), GoneError);
});

test('a reply to a request that closed in between reports Gone', () => {
  const b = broker();
  const x = held();
  const id = b.hold('aaaa0001', WRITE, '/REPO', x.h)!;
  x.close(); // closed, but the close event has not arrived yet
  assert.throws(() => b.answer('aaaa0001', id, { action: 'allow' }), GoneError);
  assert.deepEqual(b.pendingFor('aaaa0001'), []);
});

test('drop forgets a session\'s decisions and releases their requests with no decision', () => {
  const b = broker();
  const w = held();
  b.hold('aaaa0001', WRITE, '/REPO', w.h);
  b.hold('aaaa0001', ASK, '/REPO', held().h);
  b.hold('bbbb0002', WRITE, '/REPO', held().h);
  assert.equal(b.pendingFor('aaaa0001').length, 2);
  b.drop('aaaa0001');
  assert.deepEqual(b.pendingFor('aaaa0001'), []);
  assert.deepEqual(w.sent, [{}]);
  assert.equal(b.pendingFor('bbbb0002').length, 1);
});

test('"always" is offered only for session-scoped accept-edits or exact rules', () => {
  assert.equal(safeAlways([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]), 'Allow edits this session');
  assert.equal(
    safeAlways([{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }]),
    'Always allow Bash(npm test) this session',
  );
  for (const bad of [
    [],
    [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }] }],
    [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }],
    [{ type: 'setMode', mode: 'acceptEdits', destination: 'projectSettings' }],
    [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
    [{ type: 'addDirectories', directories: ['/'], destination: 'session' }],
    [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash' }] }],
    [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: ' ' }] }],
    [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [] }],
  ]) assert.equal(safeAlways(bad), null, JSON.stringify(bad));
  const wide = decisionOf({ ...bash('git push origin x'), permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }] }] }, '/REPO', DEFAULT_RULES, 5);
  assert.equal(wide.view.canAlways, undefined);
  assert.throws(() => replyFor(wide, { action: 'always' }), /session-only/);
});

test('a question or plan settles on its tool name (its input gains answers); permissions need the exact input', () => {
  const b = broker();
  const q = held();
  b.hold('aaaa0001', ASK, '/REPO', q.h);
  b.settle('aaaa0001', { tool: 'AskUserQuestion', input: { ...ASK.tool_input, answers: { x: 'y' } } });
  assert.deepEqual(b.pendingFor('aaaa0001'), []);
  assert.deepEqual(q.sent, [{}]);
});

test('at most MAX_PENDING held requests per session', () => {
  const b = broker();
  for (let i = 0; i < MAX_PENDING; i++) assert.ok(b.hold('aaaa0001', bash(`echo ${i}`), '/REPO', held().h));
  assert.equal(b.hold('aaaa0001', bash('echo over'), '/REPO', held().h), null);
  assert.ok(b.hold('bbbb0002', bash('echo other'), '/REPO', held().h));
});

test('settle: a matching tool run settles one request; a Stop settles the whole session; each gets an empty answer', () => {
  const changes: string[] = [];
  const b = broker(changes);
  const x = held();
  const y = held();
  const z = held();
  b.hold('aaaa0001', bash('mkdir a'), '/REPO', x.h);
  b.hold('aaaa0001', bash('mkdir b'), '/REPO', y.h);
  b.hold('bbbb0002', bash('mkdir a'), '/REPO', z.h);
  b.settle('aaaa0001', { tool: 'Bash', input: { command: 'mkdir b', description: 'd' } });
  assert.deepEqual(b.pendingFor('aaaa0001').map((d) => d.command), ['mkdir a']);
  assert.deepEqual(y.sent, [{}]);
  b.settle('aaaa0001', { tool: 'Bash', input: { command: 'mkdir zzz' } }); // no match: nothing changes
  assert.equal(b.pendingFor('aaaa0001').length, 1);
  b.settle('aaaa0001');
  assert.deepEqual(b.pendingFor('aaaa0001'), []);
  assert.deepEqual(x.sent, [{}]);
  assert.equal(b.pendingFor('bbbb0002').length, 1, 'other sessions are untouched');
  assert.deepEqual(z.sent, []);
});
