import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { killSocket, startServer, tempHome, uniqueSocket } from '../helpers.ts';

const FAKE = join(import.meta.dirname, '..', 'fake-claude.mjs');
const socket = uniqueSocket();
const home = tempHome();
let srv: Awaited<ReturnType<typeof startServer>>;

type Res = { status: number; json: () => any };

function call(method: string, path: string, body?: unknown, raw?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request(srv.url + path, { method, headers: { 'x-tend-token': srv.token, 'content-type': 'application/json' } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: () => JSON.parse(b) }));
    });
    r.on('error', reject);
    r.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  return assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}

const view = async (id: string): Promise<any> => ((await call('GET', '/api/sessions')).json() as any[]).find((s) => s.id === id);
const type = (id: string, text: string): Promise<Res> => call('POST', `/api/sessions/${id}/keys`, undefined, `${text}\r`);
const decide = (id: string, did: string, body: unknown): Promise<Res> => call('POST', `/api/sessions/${id}/decisions/${did}`, body);
const answers = (id: string): { tag: string; answer: any }[] => {
  const f = join(home, 'sessions', id, 'answers.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const firstDecision = (id: string, what: string) => until(async () => (await view(id))?.decisions?.[0], 5000, what);
const mk = async (name: string): Promise<string> => {
  const r = await call('POST', '/api/sessions', { cwd: home, name, isolate: false });
  assert.equal(r.status, 201);
  return r.json().id;
};

before(async () => {
  srv = await startServer({ TEND_HOME: home, TEND_TMUX_SOCKET: socket, TEND_NOTIFY: 'off', TEND_CLAUDE_BIN: FAKE });
});

after(async () => {
  await srv?.stop();
  killSocket(socket);
});

test('a permission answered on a card reaches Claude; the session carries on working', async () => {
  const id = await mk('perm');
  await type(id, 'perm');
  const d = await firstDecision(id, 'permission card');
  assert.equal(d.kind, 'permission');
  assert.equal(d.tool, 'Write');
  // the fixture writes to /REPO/hello.txt, outside this session's folder
  assert.deepEqual(d.risk, { level: 'high', rule: 'Writes outside the session folder' });
  assert.equal(d.filePath, '/REPO/hello.txt');
  assert.equal((await view(id)).state.status, 'needs_you');
  assert.equal((await decide(id, d.id, { action: 'allow' })).status, 400, 'high risk (writes outside) needs a confirmed allow');
  const r = await decide(id, d.id, { action: 'allow', confirm: true });
  assert.equal(r.status, 200);
  assert.equal(r.json().state.status, 'working');
  assert.equal(r.json().decisions, undefined);
  const got = await until(() => answers(id)[0], 3000, 'fake claude got the answer');
  assert.deepEqual(got, { tag: 'perm', answer: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } });
  // a second answer to the same request is a no-op
  assert.equal((await decide(id, d.id, { action: 'deny' })).status, 409);
  assert.equal(answers(id).length, 1);
});

test('a question card answers with the picked option; a plan card approves the plan', async () => {
  const id = await mk('qp');
  await type(id, 'ask');
  const q = await firstDecision(id, 'question card');
  assert.equal(q.kind, 'question');
  const question = q.questions[0];
  assert.equal((await decide(id, q.id, { action: 'answers', answers: { [question.question]: 'Nope' } })).status, 400);
  assert.equal((await decide(id, q.id, { action: 'allow' })).status, 400);
  assert.equal((await decide(id, q.id, { action: 'answers', answers: { [question.question]: question.options[0].label } })).status, 200);
  const qa = await until(() => answers(id)[0], 3000, 'question answer');
  assert.deepEqual(qa.answer.hookSpecificOutput.decision.updatedInput.answers, { [question.question]: question.options[0].label });

  await type(id, 'plan');
  const p = await firstDecision(id, 'plan card');
  assert.equal(p.kind, 'plan');
  assert.match(p.plan, /plan\.txt/);
  assert.equal((await decide(id, p.id, { action: 'approve' })).status, 200);
  const pa = await until(() => answers(id)[1], 3000, 'plan answer');
  assert.equal(pa.answer.hookSpecificOutput.decision.behavior, 'allow');
  assert.match(pa.answer.hookSpecificOutput.decision.updatedInput.plan, /plan\.txt/);
});

test('answered in the terminal first: the card resolves and a late card answer is 409, never an allow', async () => {
  const id = await mk('tui');
  await type(id, 'perm');
  const d = await firstDecision(id, 'permission card');
  await type(id, 'tui');
  await until(async () => ((await view(id)).decisions === undefined ? true : undefined), 3000, 'card resolved');
  const r = await decide(id, d.id, { action: 'allow' });
  assert.equal(r.status, 409);
  assert.match(r.json().error, /Already answered/);
  await new Promise((res) => setTimeout(res, 200));
  assert.deepEqual(answers(id), []);
});

test('high risk refuses "always"; bad ids and bodies are rejected', async () => {
  const id = await mk('risky');
  await type(id, 'bash rm -rf build');
  const d = await firstDecision(id, 'high-risk card');
  assert.deepEqual(d.risk, { level: 'high', rule: 'Recursive delete' });
  assert.equal(d.canAlways, undefined);
  assert.equal((await decide(id, d.id, { action: 'always' })).status, 400);
  assert.equal((await decide(id, d.id, { action: 'maybe' })).status, 400);
  assert.equal((await decide(id, 'zzzzzzzzzzzzzzzz', { action: 'allow' })).status, 404);
  assert.equal((await decide('00000000', d.id, { action: 'allow' })).status, 404);
  assert.equal((await decide(id, 'abcdef0123456789', { action: 'allow' })).status, 409);
  assert.equal((await decide(id, d.id, { action: 'allow' })).status, 400, 'high risk needs confirm');
  assert.equal((await view(id)).decisions.length, 1, 'refused answers keep the card');
  assert.equal((await decide(id, d.id, { action: 'deny', message: 'not today' })).status, 200);
  const got = await until(() => answers(id)[0], 3000, 'deny');
  assert.deepEqual(got.answer.hookSpecificOutput.decision, { behavior: 'deny', message: 'not today' });
});

test('20 interleaved permissions across 4 sessions: every answer reaches its own request (zero mis-approvals)', async () => {
  const ids = [await mk('s1'), await mk('s2'), await mk('s3'), await mk('s4')];
  const expected = new Map<string, Map<string, 'allow' | 'deny'>>(ids.map((id) => [id, new Map()]));
  // raise 5 per session, interleaved: s1#0, s2#0, s3#0, s4#0, s1#1, ...
  for (let n = 0; n < 5; n++) {
    for (const [i, id] of ids.entries()) {
      const cmd = `echo s${i + 1}-${n}`;
      expected.get(id)!.set(cmd, (i + n) % 2 === 0 ? 'allow' : 'deny');
      await type(id, `bash ${cmd}`);
    }
  }
  for (const id of ids) await until(async () => ((await view(id)).decisions?.length === 5 ? true : undefined), 8000, `5 cards for ${id}`);
  // answer in a different order: newest session first, cards in reverse
  for (const id of [...ids].reverse()) {
    const ds = [...(await view(id)).decisions].reverse();
    for (const d of ds) {
      const want = expected.get(id)!.get(d.command)!;
      assert.ok(want, `card ${d.command} belongs to ${id}`);
      assert.equal((await decide(id, d.id, { action: want, ...(want === 'allow' ? { confirm: true } : {}) })).status, 200);
    }
  }
  for (const id of ids) {
    const got = await until(() => (answers(id).length === 5 ? answers(id) : undefined), 5000, `5 answers for ${id}`);
    for (const { tag, answer } of got) assert.equal(answer.hookSpecificOutput.decision.behavior, expected.get(id)!.get(tag), `${id} ${tag}`);
    assert.equal((await view(id)).decisions, undefined);
  }
});

test('a session that ends drops its decisions', async () => {
  const id = await mk('ends');
  await type(id, 'perm');
  const d = await firstDecision(id, 'card');
  await type(id, 'exit');
  await until(async () => ((await view(id)).state.status === 'ended' ? true : undefined), 5000, 'ended');
  assert.equal((await view(id)).decisions, undefined);
  assert.equal((await decide(id, d.id, { action: 'allow' })).status, 409);
});

test('answered in the terminal while Claude keeps the request open (2.1.312): the tool run settles the card', async () => {
  const id = await mk('tui-open');
  await type(id, 'perm');
  const d = await firstDecision(id, 'permission card');
  await type(id, 'tui-open');
  await until(async () => ((await view(id)).decisions === undefined ? true : undefined), 3000, 'card settled');
  assert.equal((await decide(id, d.id, { action: 'allow' })).status, 409);
  const got = await until(() => answers(id)[0], 3000, 'the empty answer');
  assert.deepEqual(got.answer, {}, 'settled with no decision, never an allow');
  // the turn ended: the session is idle, not "waiting for you in the terminal"
  assert.equal((await view(id)).state.status, 'idle');
});

test('the hook token reaches /hook only: it cannot list sessions or answer cards', async () => {
  const id = await mk('tokens');
  await type(id, 'bash echo hi');
  const d = await firstDecision(id, 'card');
  const settings = JSON.parse(readFileSync(join(home, 'sessions', id, 'settings.json'), 'utf8'));
  const hookToken = settings.hooks.Stop[0].hooks[0].headers['x-tend-token'];
  assert.equal(hookToken, readFileSync(join(home, 'hook-token'), 'utf8').trim());
  assert.notEqual(hookToken, srv.token);
  assert.ok(!readFileSync(join(home, 'sessions', id, 'curl.conf'), 'utf8').includes(srv.token), 'the UI token is in no session file');
  const as = (method: string, path: string, body?: unknown): Promise<number> =>
    new Promise((resolve, reject) => {
      const r = request(srv.url + path, { method, headers: { 'x-tend-token': hookToken, 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      r.on('error', reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  assert.equal(await as('GET', '/api/sessions'), 401);
  assert.equal(await as('GET', '/api/events'), 401);
  assert.equal(await as('POST', `/api/sessions/${id}/decisions/${d.id}`, { action: 'allow' }), 401);
  assert.equal((await view(id)).decisions.length, 1);
});

test('two cards: answering one keeps the session in needs-you for the other', async () => {
  const id = await mk('two');
  await type(id, 'bash echo one');
  await type(id, 'bash echo two');
  await until(async () => ((await view(id)).decisions?.length === 2 ? true : undefined), 5000, 'two cards');
  const [first] = (await view(id)).decisions;
  const r = await decide(id, first.id, { action: 'allow' });
  assert.equal(r.status, 200);
  assert.equal(r.json().state.status, 'needs_you');
  assert.equal(r.json().decisions.length, 1);
});
