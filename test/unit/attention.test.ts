import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttention } from '../../src/attention.ts';
import { DEFAULTS, inQuiet, validate } from '../../src/settings.ts';
import type { Settings } from '../../src/settings.ts';

const MIN = 60_000;
function rig(s: Partial<Settings> = {}, start = new Date(2026, 9, 29, 12, 0).getTime()) {
  let t = start;
  const settings: Settings = { ...DEFAULTS, ...s };
  const out: { title: string; body: string }[] = [];
  const relevant = new Set<string>();
  const a = createAttention({
    settings: () => settings,
    deliver: (i) => out.push({ title: i.title, body: i.body }),
    now: () => t,
    stillRelevant: (h) => !relevant.size || relevant.has(h.sessionId),
  });
  return { a, out, settings, relevant, at: (m: number) => (t = start + m * MIN) };
}
const n = (id: string, urgent = false) => ({ sessionId: id, title: id, body: `${id} needs you`, urgent, kind: 'need' as const });

test('focus window: non-urgent items wait and leave together; urgent ones notify at once', () => {
  const r = rig();
  r.a.notify(n('api'));
  r.a.notify(n('docs'));
  assert.deepEqual(r.out, []);
  r.a.notify(n('deploy', true));
  assert.deepEqual(r.out, [{ title: 'deploy', body: 'deploy needs you' }]);
  r.at(24);
  r.a.tick();
  assert.equal(r.out.length, 1);
  assert.equal(r.a.view().held.length, 2);
  r.at(25);
  r.a.tick();
  assert.deepEqual(r.out[1], { title: '2 sessions need you', body: 'api, docs' });
  assert.equal(r.a.view().held.length, 0);
});

test('one held item per session; release skips items already dealt with; Show now', () => {
  const r = rig();
  r.a.notify(n('api'));
  r.a.notify({ ...n('api'), body: 'api again' });
  r.a.notify(n('docs'));
  assert.equal(r.a.view().held.length, 2);
  r.relevant.add('docs'); // api was answered meanwhile
  r.a.showNow();
  assert.deepEqual(r.out, [{ title: 'docs', body: 'docs needs you' }]);
});

test('focus windows off: everything notifies at once (v0.4 behaviour), within the budget', () => {
  const r = rig({ focus: { enabled: false, minutes: 25 }, budgetPerHour: 2 });
  r.a.notify(n('a'));
  r.a.notify(n('b'));
  r.a.notify(n('c'));
  assert.deepEqual(r.out.map((o) => o.title), ['a', 'b']);
  assert.equal(r.a.view().held.length, 1, 'over the budget: held');
  r.at(61);
  r.a.tick();
  assert.deepEqual(r.out.map((o) => o.title), ['a', 'b', 'c']);
});

test('quiet hours hold everything, urgent included, and say so when they end', () => {
  const r = rig({ quiet: { enabled: true, start: '22:00', end: '08:00' } }, new Date(2026, 9, 29, 23, 0).getTime());
  r.a.notify(n('api', true));
  r.a.notify(n('docs'));
  assert.deepEqual(r.out, []);
  assert.equal(r.a.view().quiet, true);
  r.at(8 * 60 + 59); // 07:59
  r.a.tick();
  assert.deepEqual(r.out, []);
  r.at(9 * 60); // 08:00
  r.a.tick();
  assert.deepEqual(r.out, [{ title: '2 sessions need you', body: 'Held 2 items during quiet hours. api, docs' }]);
});

test('a release names at most three sessions', () => {
  const r = rig();
  for (const id of ['a', 'b', 'c', 'd', 'e']) r.a.notify(n(id));
  r.a.showNow();
  assert.deepEqual(r.out, [{ title: '5 sessions need you', body: 'a, b, c and 2 more' }]);
});

test('settings: validation and quiet hours across midnight', () => {
  assert.deepEqual(validate({}), DEFAULTS);
  assert.equal(validate({ focus: { minutes: 10 } }).focus.minutes, 10);
  assert.throws(() => validate({ focus: { minutes: 1 } }), /focus.minutes/);
  assert.throws(() => validate({ quiet: { start: '25:00' } }), /quiet.start/);
  assert.throws(() => validate({ wipLimit: 'x' }), /wipLimit/);
  const s = validate({ quiet: { enabled: true, start: '22:00', end: '08:00' } });
  assert.equal(inQuiet(s, new Date(2026, 0, 1, 23, 30).getTime()), true);
  assert.equal(inQuiet(s, new Date(2026, 0, 1, 7, 59).getTime()), true);
  assert.equal(inQuiet(s, new Date(2026, 0, 1, 8, 0).getTime()), false);
  assert.equal(inQuiet(validate({ quiet: { enabled: true, start: '13:00', end: '14:00' } }), new Date(2026, 0, 1, 13, 30).getTime()), true);
  assert.equal(inQuiet(DEFAULTS, new Date(2026, 0, 1, 23, 30).getTime()), false);
});

test('held items survive a restart (load/save), quiet-hour count included', () => {
  let saved: any = null;
  const settings = { ...DEFAULTS, quiet: { enabled: true, start: '22:00', end: '08:00' } };
  let t = new Date(2026, 9, 29, 23, 0).getTime();
  const out: string[] = [];
  const mk = () => createAttention({ settings: () => settings, deliver: (i) => out.push(i.body), now: () => t, load: () => saved, save: (s) => (saved = JSON.parse(JSON.stringify(s))) });
  mk().notify(n('api'));
  assert.equal(saved.held.length, 1);
  assert.equal(saved.heldInQuiet, 1);
  t = new Date(2026, 9, 30, 9, 0).getTime(); // Tend was down when quiet hours ended
  const again = mk();
  assert.equal(again.view().held.length, 1);
  again.tick();
  assert.deepEqual(out, ['Held 1 item during quiet hours. api']);
});

test('an urgent held item is not replaced by a lesser one; drop removes only "needs you" items', () => {
  const r = rig({ quiet: { enabled: true, start: '00:00', end: '23:59' } });
  r.a.notify({ sessionId: 'x', title: 'x', body: 'Same Bash error 3 times', urgent: true });
  r.a.notify(n('x'));
  assert.equal(r.a.view().held[0]!.body, 'Same Bash error 3 times');
  r.a.notify(n('y'));
  r.a.drop('x');
  r.a.drop('y');
  assert.deepEqual(r.a.view().held.map((h) => h.sessionId), ['x']);
});

test('a mixed release is "things to look at"; a single quiet-hours item is one session', () => {
  const r = rig();
  r.a.notify({ sessionId: 'p', title: 'Keeping a sustainable pace', body: 'hot' });
  r.a.notify(n('api'));
  r.a.showNow();
  assert.equal(r.out[0]!.title, '2 things to look at');
});
