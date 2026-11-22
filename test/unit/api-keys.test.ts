import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, sendKeys } from '../../ui/api.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MAX = 32 * 1024;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Record each /keys body in arrival order; respond with `status` (204 by default). */
function recordFetch(status: (n: number) => number = () => 204): string[] {
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    await new Promise((r) => setTimeout(r, Math.random() * 3)); // jitter: order must come from the queue
    const s = status(bodies.length);
    return new Response(s === 204 ? null : JSON.stringify({ error: 'boom' }), { status: s });
  }) as typeof fetch;
  return bodies;
}

test('sendKeys splits a large paste into in-order chunks of at most 32 KB of UTF-8', async () => {
  const bodies = recordFetch();
  // multi-byte text plus an emoji (surrogate pair) placed right on a 32 KB boundary
  const paste = 'a'.repeat(MAX - 2) + '😀' + 'é—中'.repeat(20_000) + 'end';
  await sendKeys('abcd1234', paste);
  assert.ok(bodies.length >= 4, `chunked into ${bodies.length} requests`);
  for (const b of bodies) {
    assert.ok(bytes(b) <= MAX, `chunk of ${bytes(b)} bytes`);
    assert.ok(!/[\ud800-\udbff]$/.test(b) && !/^[\udc00-\udfff]/.test(b), 'no split surrogate pair');
  }
  assert.equal(bodies.join(''), paste);
});

test('small input is one request, and order holds across calls', async () => {
  const bodies = recordFetch();
  await Promise.all([sendKeys('abcd1234', 'x'), sendKeys('abcd1234', 'y'), sendKeys('abcd1234', 'z')]);
  assert.deepEqual(bodies, ['x', 'y', 'z']);
});

test('a failed chunk rejects with the ApiError, later keystrokes still go out', async () => {
  const bodies = recordFetch((n) => (n === 2 ? 500 : 204));
  const big = 'b'.repeat(MAX * 2 + 10);
  await assert.rejects(sendKeys('abcd1234', big), (e) => e instanceof ApiError && e.status === 500);
  await sendKeys('abcd1234', 'after');
  assert.equal(bodies.at(-1), 'after');
});
