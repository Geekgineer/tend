import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parkable } from '../../src/park.ts';

const v = (id: string, status: string, since: number, extra: Record<string, unknown> = {}) => ({ id, paused: false, state: { status, since }, ...extra });
const PROMPT = '╭────╮\n│ ❯  │\n╰────╯\n  fake claude';
const DIALOG = 'Bash command\n mkdir x\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel';

test('park picks only working sessions with no card, not just changed, and no dialog on screen', () => {
  const now = 10_000;
  const views = [
    v('ok', 'working', 1000),
    v('idle', 'idle', 1000),
    v('fresh', 'working', now - 500),
    v('card', 'working', 1000, { decisions: [{}] }),
    v('dialog', 'working', 1000),
    v('paused', 'working', 1000, { paused: true }),
    v('gone', 'working', 1000),
  ];
  const screens: Record<string, string> = { ok: PROMPT, dialog: DIALOG, fresh: PROMPT, card: PROMPT };
  const picked = parkable(views, (id) => {
    if (id === 'gone') throw new Error('no pane');
    return screens[id] ?? PROMPT;
  }, now);
  assert.deepEqual(picked.map((x) => x.id), ['ok']);
});
