import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateToken, tendHome } from '../../src/config.ts';

test('loadOrCreateToken creates a 64-hex token with mode 0600 and returns the same token on the second call', () => {
  const home = mkdtempSync(join(tmpdir(), 'tend-cfg-'));
  const a = loadOrCreateToken(home);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(statSync(join(home, 'token')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(home, 'token'), 'utf8').trim(), a);
  assert.equal(loadOrCreateToken(home), a);
});

test('tendHome tightens an existing data dir to 0700', () => {
  const home = join(mkdtempSync(join(tmpdir(), 'tend-cfg-')), 'home');
  mkdirSync(home, { mode: 0o755 });
  chmodSync(home, 0o755);
  const prev = process.env.TEND_HOME;
  process.env.TEND_HOME = home;
  try {
    assert.equal(tendHome(), home);
  } finally {
    if (prev === undefined) delete process.env.TEND_HOME;
    else process.env.TEND_HOME = prev;
  }
  assert.equal(statSync(home).mode & 0o777, 0o700);
});

test('loadOrCreateToken re-tightens an existing token file to 0600 and keeps the token', () => {
  const home = mkdtempSync(join(tmpdir(), 'tend-cfg-'));
  const token = 'ab'.repeat(32);
  writeFileSync(join(home, 'token'), token + '\n', { mode: 0o644 });
  chmodSync(join(home, 'token'), 0o644);
  assert.equal(loadOrCreateToken(home), token);
  assert.equal(statSync(join(home, 'token')).mode & 0o777, 0o600);
});
