import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../../src/security.ts';

const TOKEN = 'a'.repeat(64);
const PORT = 4977;
const req = (headers: Record<string, string> = {}, url = '/') => ({
  headers: { host: `127.0.0.1:${PORT}`, ...headers },
  url,
});

test('accepts the header token', () => {
  assert.deepEqual(authorize(req({ 'x-tend-token': TOKEN }), TOKEN, PORT), { ok: true });
});

test('accepts ?key=<token> and sets a session cookie', () => {
  assert.deepEqual(authorize(req({}, `/?key=${TOKEN}`), TOKEN, PORT), {
    ok: true,
    setCookie: `tend_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
  });
});

test('accepts cookie tend_token', () => {
  assert.deepEqual(authorize(req({ cookie: `x=1; tend_token=${TOKEN}` }), TOKEN, PORT), { ok: true });
});

test('missing or wrong token is 401', () => {
  assert.deepEqual(authorize(req(), TOKEN, PORT), { ok: false, status: 401 });
  assert.deepEqual(authorize(req({ 'x-tend-token': 'b'.repeat(64) }), TOKEN, PORT), { ok: false, status: 401 });
});

test('different-length token is 401 without throwing', () => {
  assert.deepEqual(authorize(req({ 'x-tend-token': 'short' }), TOKEN, PORT), { ok: false, status: 401 });
});

test('foreign Origin is 403 even with a valid token', () => {
  assert.deepEqual(authorize(req({ 'x-tend-token': TOKEN, origin: 'http://evil.com' }), TOKEN, PORT), { ok: false, status: 403 });
});

test('foreign Host is 403 even with a valid token', () => {
  assert.deepEqual(authorize(req({ 'x-tend-token': TOKEN, host: 'evil.com:4977' }), TOKEN, PORT), { ok: false, status: 403 });
});

test('localhost Origin with valid token is ok', () => {
  assert.deepEqual(authorize(req({ 'x-tend-token': TOKEN, origin: `http://localhost:${PORT}` }), TOKEN, PORT), { ok: true });
});
