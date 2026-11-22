import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheWarning, contextFacts, evenPace, FIVE_HOURS, left, ringHTML, ringLevel, tokens } from '../../ui/usage.js';

test('rings show only at 60% and above: grey, amber 70–85, red above 85', () => {
  assert.equal(ringLevel(59), null);
  assert.equal(ringLevel(null), null);
  assert.equal(ringLevel(60), 'calm');
  assert.equal(ringLevel(70), 'warn');
  assert.equal(ringLevel(85), 'warn');
  assert.equal(ringLevel(86), 'hot');
  assert.equal(ringHTML({ pct: 40, tokens: 0, size: null, model: null, cache: null, at: 0 }), '');
  assert.match(ringHTML({ pct: 90, tokens: 0, size: null, model: null, cache: null, at: 0 }), /class="ring hot".*Context 90%/);
});

test('facts: context with tokens and size, cache warm with time left, advisory at 80%', () => {
  const now = 1_000_000;
  const c = { pct: 54, tokens: 108_000, size: 1_000_000, model: 'x', cache: { warm: true, expiresAt: now + 120_000, recacheTokens: 118_000 }, at: now };
  assert.deepEqual(contextFacts(c, now).map((f) => f.text), ['context 54% · 108k / 1M', 'cache warm · 2 min left']);
  const hot = contextFacts({ ...c, pct: 88 }, now)[0]!;
  assert.equal(hot.text, 'context 88% · 108k / 1M · auto-compact soon');
  assert.equal(hot.cls, 'warn');
  assert.equal(contextFacts({ ...c, cache: { warm: false, expiresAt: null, recacheTokens: 5000 } }, now)[1]!.text, 'cache cold');
  assert.deepEqual(contextFacts(undefined, now), []);
});

test('a pending decision warns when the cache goes cold within 3 min', () => {
  const now = 1_000_000;
  const c = (ms: number) => ({ pct: 10, tokens: 0, size: null, model: null, cache: { warm: true, expiresAt: now + ms, recacheTokens: 118_000 }, at: now });
  assert.equal(cacheWarning(c(120_000), now), 'Prompt cache goes cold in 2 min. Answering after that re-reads about 118k tokens.');
  assert.equal(cacheWarning(c(4 * 60_000), now), null);
  assert.equal(cacheWarning(c(-1), now), null);
});

test('formatting helpers', () => {
  assert.equal(left(118 * 60_000), '1 h 58 min');
  assert.equal(left(10_000), 'now');
  assert.equal(left(60 * 60_000), '1 h');
  assert.equal(left(3 * 24 * 3600_000 + 2 * 3600_000), '3 d 2 h');
  assert.equal(tokens(1_000_000), '1M');
  assert.equal(tokens(1_500_000), '1.5M');
  assert.equal(tokens(108_400), '108k');
  assert.equal(evenPace({ pct: 0, resetsAt: FIVE_HOURS / 2, zone: 'chill', projected: 0, confident: true, projection: '' }, FIVE_HOURS, 0), 50);
});
