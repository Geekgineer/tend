import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBriefing } from '../../src/briefing.ts';
import type { TendEvent } from '../../src/events.ts';

const dir = join(import.meta.dirname, '..', 'fixtures', 'phase0');

const ev = (ts: number, kind: TendEvent['kind'], data: unknown, tool?: string): TendEvent => ({
  ts,
  sessionId: 's',
  kind,
  data,
  ...(tool ? { tool } : {}),
});
const edit = (ts: number, file: unknown, tool = 'Write') =>
  ev(ts, 'PostToolUse', { tool_input: { file_path: file } }, tool);
const prompt = (ts: number, p: unknown) => ev(ts, 'UserPromptSubmit', { prompt: p });
const stop = (ts: number, m: unknown) => ev(ts, 'Stop', { last_assistant_message: m });

test('fixture replay gives the expected briefing', () => {
  const evs = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f, i) => {
      const body = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
      return {
        ts: i,
        sessionId: 's',
        kind: body.hook_event_name,
        tool: body.tool_name,
        data: body,
      } as TendEvent;
    });
  const b = buildBriefing(evs, '/REPO');
  assert.equal(b.goal, 'Create a file named hello.txt containing the word hi. Do nothing else.');
  assert.equal(b.instructions.length, 13);
  assert.deepEqual(b.files, ['hello.txt', 'two.txt', 'a.txt', 'b.txt', 'c.txt', 'auto.txt']);
  assert.equal(b.done.length, 7);
  assert.deepEqual(
    b.done.map((d) => d.files),
    [['hello.txt'], ['two.txt'], [], ['a.txt', 'b.txt', 'c.txt'], [], [], ['auto.txt']],
  );
  assert.equal(b.done[2]?.text, 'Blue');
  assert.deepEqual(b.working, []);
});

test('a path under realpath(root) is made relative when root is a symlinked tmp dir', () => {
  const base = mkdtempSync(join(tmpdir(), 'tend-brief-'));
  const real = join(base, 'real');
  mkdirSync(real);
  const link = join(base, 'link');
  symlinkSync(real, link);
  const b = buildBriefing(
    [edit(1, join(realpathSync(real), 'src', 'x.ts')), edit(2, join(link, 'y.ts')), edit(3, join(real, '.tend', 'z'))],
    link,
  );
  assert.deepEqual(b.files, ['src/x.ts', 'y.ts']);
  assert.deepEqual(b.working, ['src/x.ts', 'y.ts']);
});

test('drops paths outside root, under .tend, and prefix lookalikes; NotebookEdit uses notebook_path', () => {
  const b = buildBriefing(
    [
      edit(1, '/REPO2/a.txt'),
      edit(2, '/REPO/.tend/x'),
      edit(3, '/elsewhere/a.txt'),
      ev(4, 'PostToolUse', { tool_input: { notebook_path: '/REPO/n.ipynb' } }, 'NotebookEdit'),
      ev(5, 'PostToolUse', { tool_input: { file_path: '/REPO/r.txt' } }, 'Read'),
    ],
    '/REPO',
  );
  assert.deepEqual(b.files, ['n.ipynb']);
});

test('truncates at 1000 chars with an ellipsis', () => {
  const b = buildBriefing([prompt(1, 'g'), prompt(2, `  ${'x'.repeat(1500)}  `), prompt(3, 'y'.repeat(1000)), stop(4, 'z'.repeat(1001))], '/REPO');
  assert.equal(b.instructions[0]?.text, `${'x'.repeat(1000)}…`);
  assert.equal(b.instructions[0]?.text.length, 1001);
  assert.equal(b.instructions[1]?.text, 'y'.repeat(1000));
  assert.equal(b.done[0]?.text, `${'z'.repeat(1000)}…`);
});

test('malformed bodies (data null, file_path number) are skipped', () => {
  const b = buildBriefing(
    [
      ev(1, 'UserPromptSubmit', null),
      prompt(2, 42),
      ev(3, 'PostToolUse', null, 'Write'),
      edit(4, 7),
      ev(5, 'PostToolUse', { tool_input: null }, 'Edit'),
      edit(6, '/REPO/ok.txt'),
      ev(7, 'Stop', null),
    ],
    '/REPO',
  );
  assert.equal(b.goal, null);
  assert.deepEqual(b.instructions, []);
  assert.deepEqual(b.files, ['ok.txt']);
  assert.equal(b.done.length, 1);
  assert.deepEqual(b.done[0]?.files, ['ok.txt']);
  assert.equal(b.done[0]?.text, '');
});

test('keeps only the last 20 instructions and done entries', () => {
  const evs: TendEvent[] = [prompt(0, 'goal')];
  for (let i = 1; i <= 25; i++) {
    evs.push(prompt(i * 2, `p${i}`), stop(i * 2 + 1, `d${i}`));
  }
  const b = buildBriefing(evs, '/REPO');
  assert.equal(b.instructions.length, 20);
  assert.equal(b.instructions[0]?.text, 'p6');
  assert.equal(b.instructions[19]?.text, 'p25');
  assert.equal(b.done.length, 20);
  assert.equal(b.done[0]?.text, 'd6');
  assert.equal(b.done[19]?.text, 'd25');
});

test('SessionEnd, resumed and trust events reset nothing; working is edits since last Stop', () => {
  const b = buildBriefing(
    [edit(1, '/REPO/a'), stop(2, 'ok'), edit(3, '/REPO/b'), edit(4, '/REPO/b'), ev(5, 'SessionEnd', {}), ev(6, 'resumed', {}), ev(7, 'trust_done', {})],
    '/REPO',
  );
  assert.deepEqual(b.working, ['b']);
  assert.deepEqual(b.files, ['a', 'b']);
});
