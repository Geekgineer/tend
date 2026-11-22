import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttention } from '../../src/attention.ts';
import { DEFAULTS } from '../../src/settings.ts';
import type { Settings } from '../../src/settings.ts';

// An 8-hour day with 12 sessions: needs-you moments every few minutes, a few urgent ones. Deterministic.
function day(settings: Settings): { delivered: number; urgentLate: number; total: number } {
  const start = new Date(2026, 9, 29, 9, 0).getTime();
  let t = start;
  let delivered = 0;
  let urgentLate = 0;
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pendingUrgent = new Set<string>();
  const a = createAttention({
    settings: () => settings,
    deliver: (i) => {
      delivered++;
      if (pendingUrgent.has(i.sessionId)) pendingUrgent.delete(i.sessionId);
    },
    now: () => t,
  });
  let total = 0;
  for (let minute = 0; minute < 8 * 60; minute++) {
    t = start + minute * 60_000;
    if (rnd() < 0.18) {
      const id = `s${Math.floor(rnd() * 12)}`;
      const urgent = rnd() < 0.08;
      total++;
      if (urgent) pendingUrgent.add(id);
      a.notify({ sessionId: id, title: id, body: 'needs you', urgent });
      if (urgent && pendingUrgent.has(id)) urgentLate++; // an urgent one that wasn't sent at once
    }
    a.tick();
  }
  return { delivered, urgentLate, total };
}

test('day in the life: focus windows cut interruptions by more than half, and urgent ones still arrive at once', () => {
  const off = day({ ...DEFAULTS, focus: { enabled: false, minutes: 25 }, budgetPerHour: 60 });
  const on = day({ ...DEFAULTS, budgetPerHour: 60 });
  assert.equal(off.delivered, off.total, 'without focus windows every moment interrupts');
  assert.ok(on.delivered < off.delivered / 2, `focus windows: ${on.delivered} interruptions vs ${off.delivered}`);
  assert.equal(on.urgentLate, 0, 'urgent items are never held by a focus window');
  process.stdout.write(`# day in the life: ${off.total} moments; ${off.delivered} interruptions without focus windows, ${on.delivered} with\n`);
});
