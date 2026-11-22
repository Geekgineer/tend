import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaneSync, DIALOG_QUIET_MS, QUIET_MS, readScreen } from '../../src/pane-sync.ts';
import { reduce } from '../../src/state.ts';

const IDLE = '⏺ I wrote notes.md.\n  ⎿  Stop hook error: connect ECONNREFUSED 127.0.0.1:55932\n✻ Churned for 5s\n──────\n❯ \n──────\n  ⏸ manual mode on';
const BUSY = '⏺ Running tests…\n✻ Thinking… (12s · esc to interrupt)\n──────\n❯ \n──────';
const DIALOG = ' Bash command\n mkdir x\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel';

test('the screen reads as a dialog, busy, or idle (2.1.312 layout)', () => {
  assert.equal(readScreen(IDLE), 'idle');
  assert.equal(readScreen(BUSY), 'busy');
  assert.equal(readScreen(DIALOG), 'dialog');
  assert.equal(readScreen('❯ Make slugify…\n· Germinating… (1s · thinking)\n──────\n❯ \n──────'), 'busy');
  assert.equal(readScreen('✢ Moonwalking… (2m 3s · ↓ 4.1k tokens)\n❯ '), 'busy');
  assert.equal(readScreen('✻ Worked for 13s · done 9:53 AM\n──────\n❯ \n──────'), 'idle');
});

function rig(status: 'working' | 'needs_you', screen: string, opts: { card?: boolean; need?: 'trust' | 'permission' } = {}) {
  let now = 1_000_000;
  const v = { id: 's1', paused: false, state: { status, since: 0, ...(opts.need ? { need: opts.need } : status === 'needs_you' ? { need: 'permission' as const } : {}) } } as any;
  const applied: string[] = [];
  const sync = createPaneSync({
    views: () => [v],
    snapshot: () => Buffer.from(screen),
    hasCard: () => opts.card ?? false,
    lastActivity: () => 1_000_000,
    apply: (view, ev) => {
      applied.push(ev.kind);
      view.state = reduce(view.state, ev);
    },
    now: () => now,
  });
  return { v, applied, sync, tick: (ms: number) => ((now += ms), sync()) };
}

test('a lost Stop: idle on screen twice, 10 s apart, after 20 s quiet → idle', () => {
  const r = rig('needs_you', IDLE);
  r.tick(QUIET_MS - 1);
  assert.deepEqual(r.applied, [], 'too soon');
  r.tick(10_000);
  assert.deepEqual(r.applied, [], 'one idle reading is not enough');
  r.tick(10_000);
  assert.deepEqual(r.applied, ['pane_idle']);
  assert.equal(r.v.state.status, 'idle');
});

test('busy on screen keeps working; a dialog Tend never heard of becomes needs-you', () => {
  const b = rig('working', BUSY);
  for (let i = 0; i < 5; i++) b.tick(15_000);
  assert.deepEqual(b.applied, []);
  const d = rig('working', DIALOG);
  d.tick(DIALOG_QUIET_MS + 1); // a dialog counts after 5 s
  assert.deepEqual(d.applied, ['pane_dialog']);
  assert.deepEqual([d.v.state.status, d.v.state.need], ['needs_you', 'permission']);
});

test('a held card or the trust prompt is never overridden by the screen', () => {
  const c = rig('needs_you', IDLE, { card: true });
  for (let i = 0; i < 5; i++) c.tick(15_000);
  assert.deepEqual(c.applied, []);
  const t = rig('needs_you', IDLE, { need: 'trust' });
  for (let i = 0; i < 5; i++) t.tick(15_000);
  assert.deepEqual(t.applied, []);
});
