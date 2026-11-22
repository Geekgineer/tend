import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIVE_HOURS, pace, parseStatus, projection, tokensUsed } from '../../src/usage.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/status/${n}`, import.meta.url), 'utf8'));

test('context, cache and both usage windows equal the status line fixture values', () => {
  const at = 1793197800 * 1000 - 3600_000; // an hour before the fixture's 5-hour reset
  const s = parseStatus(fx('010-statusline.json'), at);
  assert.deepEqual(s.context, {
    pct: 6,
    tokens: 59634 + 109,
    size: 1000000,
    model: 'Haiku 5.5',
    cache: { warm: true, expiresAt: 1793199906 * 1000, recacheTokens: 59634 },
    at,
  });
  assert.deepEqual(s.limits, { fiveHour: { pct: 10, resetsAt: 1793197800 * 1000 }, sevenDay: { pct: 53, resetsAt: 1793451600 * 1000 } });
});

test('before the first turn: pct null and no limits; a later null keeps the last pct, marked stale', () => {
  const first = parseStatus(fx('001-statusline.json'), 1);
  assert.equal(first.context.pct, null);
  assert.deepEqual(first.limits, { fiveHour: null, sevenDay: null });
  const known = parseStatus(fx('010-statusline.json'), 2).context;
  const after = parseStatus({ context_window: { used_percentage: null } }, 3, known);
  assert.equal(after.context.pct, 6);
  assert.equal(after.context.stale, true);
  assert.equal(parseStatus('garbage', 4).context.pct, null);
});

test('values are range-checked: % in 0–100, reset times plausible, token counts bounded', () => {
  const now = Date.UTC(2026, 9, 29);
  const s = parseStatus({
    context_window: { used_percentage: 1e300, total_input_tokens: 1e300, context_window_size: -5 },
    rate_limits: { five_hour: { used_percentage: -1e300, resets_at: now / 1000 + 3600 }, seven_day: { used_percentage: 50, resets_at: 1e306 } },
  }, now);
  assert.equal(s.context.pct, 100);
  assert.equal(s.context.tokens, 1e10);
  assert.equal(s.context.size, 0);
  assert.deepEqual(s.limits.fiveHour, { pct: 0, resetsAt: now + 3600_000 });
  assert.equal(s.limits.sevenDay, null);
  assert.equal(parseStatus({ rate_limits: { five_hour: { used_percentage: 5, resets_at: now / 1000 - 3 * 86400 } } }, now).limits.fiveHour, null);
});

test('pacing zones follow the spec thresholds', () => {
  const now = 1_000_000_000_000;
  // a window half gone: projected = 2 × used
  const half = (pct: number) => ({ pct, resetsAt: now + FIVE_HOURS / 2 });
  const zone = (pct: number) => pace(half(pct), FIVE_HOURS, now).zone;
  assert.equal(zone(30), 'chill'); // projected 60
  assert.equal(zone(40), 'on_pace'); // projected 80
  assert.equal(zone(50), 'warning'); // projected 100
  assert.equal(zone(58), 'hot'); // projected 116
  assert.equal(pace({ pct: 76, resetsAt: now + FIVE_HOURS * 0.01 }, FIVE_HOURS, now).zone, 'warning'); // used ≥ 75 late in the window (projected 77)
  assert.equal(pace({ pct: 91, resetsAt: now + 1 }, FIVE_HOURS, now).zone, 'hot');
  assert.equal(pace(half(40), FIVE_HOURS, now).projected, 80);
  assert.equal(pace({ pct: 5, resetsAt: now + FIVE_HOURS * 0.95 }, FIVE_HOURS, now).confident, false);
  // early in a window only the used % counts: 2% at 1% elapsed is not hot
  assert.equal(pace({ pct: 2, resetsAt: now + FIVE_HOURS * 0.99 }, FIVE_HOURS, now).zone, 'chill');
  assert.equal(pace({ pct: 80, resetsAt: now + FIVE_HOURS * 0.99 }, FIVE_HOURS, now).zone, 'warning');
  assert.equal(pace({ pct: 3, resetsAt: now + FIVE_HOURS * 2 }, FIVE_HOURS, now).zone, 'chill');
});

test('hysteresis: calming down needs a 3-point margin, heating up is immediate', () => {
  const now = 1_000_000_000_000;
  const half = (pct: number) => ({ pct, resetsAt: now + FIVE_HOURS / 2 });
  assert.equal(pace(half(49), FIVE_HOURS, now, 'warning').zone, 'warning'); // projected 98: within margin
  assert.equal(pace(half(48), FIVE_HOURS, now, 'warning').zone, 'on_pace'); // projected 96: past it
  assert.equal(pace(half(50), FIVE_HOURS, now, 'chill').zone, 'warning');
  assert.equal(pace(half(37), FIVE_HOURS, now, 'on_pace').zone, 'on_pace'); // projected 74: within the margin
  assert.equal(pace(half(35), FIVE_HOURS, now, 'on_pace').zone, 'chill'); // projected 70: past the margin
  assert.equal(pace(half(38), FIVE_HOURS, now, 'chill').zone, 'on_pace'); // heating up is immediate
});

test('projection says when you reach it at this pace', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0);
  const w = { pct: 60, resetsAt: now + FIVE_HOURS / 2 }; // 60% in 2.5 h: full in another 1 h 40 min
  assert.match(projection(w, FIVE_HOURS, now), /^At this pace you reach it around \d\d:\d\d, 50 min before it resets\.$/);
  assert.match(projection({ pct: 20, resetsAt: now + FIVE_HOURS / 2 }, FIVE_HOURS, now), /stay under it/);
  assert.match(projection({ pct: 100, resetsAt: now + 1000 }, FIVE_HOURS, now), /^Used up until/);
});

test('tokens used in the last 30 min, ignoring drops from compaction', () => {
  const m = 60_000;
  const s = [{ at: 0, tokens: 100 }, { at: 10 * m, tokens: 500 }, { at: 20 * m, tokens: 200 }, { at: 40 * m, tokens: 900 }];
  assert.equal(tokensUsed(s, 41 * m), 700); // samples from 11 min on: 200 → 900
  assert.equal(tokensUsed(s, 25 * m), 400); // 100 → 500 (+400), 500 → 200 (drop, 0)
});
