import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { authorize } from './security.ts';
import { first, HttpError, logInternal, readJson, readRaw, send } from './http.ts';
export { logInternal } from './http.ts';
import { loadOrCreateHookToken } from './config.ts';
import { openStore } from './store.ts';
import { createTmux } from './tmux.ts';
import type { Tmux } from './tmux.ts';
import { acquire, release } from './control-mode.ts';
import { createNotifier } from './notifier.ts';
import type { NotifyMode } from './notifier.ts';
import { serveStatic, SIGN_IN_PAGE, STATIC_FILES } from './static.ts';
import { createRegistry, expandHome, isSessionId, tmuxName, UserError } from './sessions.ts';
import { repoInfo } from './git.ts';
import { cancelFolderPanel, chooseFolder, stopFolderPanel } from './choose-folder.ts';
import { createSettings } from './settings.ts';
import { createAttention, heldFile } from './attention.ts';
import { parkable } from './park.ts';
import { createCompat } from './compat.ts';
import { claudeBin, writeStatusShim } from './claude-launch.ts';
import { ATTACH_ROUTE, attachmentFile, attachmentsList, upload } from './media-routes.ts';
import { file, raw, reviewDiff, say, tree } from './review-routes.ts';
import { adopt, listExternal } from './external-routes.ts';
import { createExternal } from './external.ts';
import type { External } from './external.ts';
import { HOME_CLAUDE, listAccounts } from './accounts.ts';
import type { Attention } from './attention.ts';
import { wrapupSince } from './wrapup.ts';
import type { Store } from './store.ts';
import type { Registry, SessionView } from './sessions.ts';
import { GoneError } from './decisions.ts';
import type { Answer } from './decisions.ts';

export const JSON_BODY_MAX = 16 * 1024;
// Hook bodies carry tool input/output (a Write's file content, a Read's result), so they get
// a larger cap than UI JSON; 16 KB would silently drop real PermissionRequest events.
export const HOOK_BODY_MAX = 1024 * 1024;
export const KEYS_BODY_MAX = 64 * 1024;
const PATH_MAX = 4096;
const GIT_REFRESH_MS = 10_000;

type App = {
  reg: Registry; sse: Set<ServerResponse>; tmux: Tmux; socket: string; token: string; hookToken: string; port: number;
  store: Store; settings: ReturnType<typeof createSettings>; attention: Attention; compat: ReturnType<typeof createCompat>; external: External;
  /** this server's identity, for the single-instance lock (not a secret) */
  instance: string;
};
export type Ctx = App & { req: IncomingMessage; res: ServerResponse; url: URL; id: string };
type Handler = (c: Ctx) => void | Promise<void>;

// ---- SSE ------------------------------------------------------------------

function sseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(sse: Set<ServerResponse>, event: string, data: unknown): void {
  for (const res of sse) sseEvent(res, event, data);
}

const events: Handler = ({ req, res, reg, sse, attention }) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(':ok\n\n'); // flush headers immediately (spike bug: no bytes = no 'open' in the browser)
  sseEvent(res, 'snapshot', reg.list());
  sseEvent(res, 'attention', attention.view());
  const off = reg.onChange((v: SessionView) => sseEvent(res, 'session', v));
  const ping = setInterval(() => res.write(':\n\n'), 25_000);
  sse.add(res);
  const cleanup = (): void => {
    off();
    clearInterval(ping);
    sse.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
};

// ---- terminal -------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)));

const snapshot: Handler = ({ res, tmux, id }) => {
  let bytes: Buffer;
  try {
    bytes = tmux.snapshot(tmuxName(id));
  } catch {
    throw new HttpError(404, 'Session not running');
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(bytes.toString('base64'));
};

const term: Handler = ({ req, res, reg, tmux, sse, socket, id }) => {
  // 404 before any SSE header: a 200 that ends at once makes EventSource reconnect forever
  if (reg.get(id)?.state.status === 'ended' || !tmux.has(tmuxName(id))) throw new HttpError(404, 'Session not running');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(':ok\n\n');
  const client = acquire(socket, tmuxName(id));
  const off = client.onBytes((b) => res.write(`data: ${b.toString('base64')}\n\n`));
  const ping = setInterval(() => res.write(':\n\n'), 25_000);
  sse.add(res);
  let done = false;
  let offExit = (): void => {};
  const cleanup = (): void => {
    if (done) return;
    done = true;
    off();
    offExit();
    clearInterval(ping);
    sse.delete(res);
    release(client);
  };
  // the tmux session (or its control client) went away: end the stream cleanly
  offExit = client.onExit(() => {
    cleanup();
    res.end();
  });
  req.on('close', cleanup);
  res.on('close', cleanup);
};

const keys: Handler = async ({ req, res, socket, id }) => {
  const bytes = await readRaw(req, KEYS_BODY_MAX);
  if (bytes.length > 0) {
    const client = acquire(socket, tmuxName(id));
    client.sendKeys(bytes);
    release(client); // a graceful close still runs the queued send-keys
  }
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
};

const resize: Handler = async ({ req, res, tmux, id }) => {
  const body = await readJson(req, JSON_BODY_MAX);
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const { cols, rows } = b;
  if (typeof cols !== 'number' || !Number.isFinite(cols) || typeof rows !== 'number' || !Number.isFinite(rows)) {
    throw new HttpError(400, 'cols and rows must be numbers');
  }
  try {
    tmux.resize(tmuxName(id), clamp(cols, 20, 400), clamp(rows, 5, 200));
  } catch {
    throw new HttpError(404, 'Session not running');
  }
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
};

// ---- lifecycle ------------------------------------------------------------

const pause: Handler = async ({ req, res, reg, id }) => {
  req.resume();
  send(res, 200, await reg.pause(id));
};

const resume: Handler = async ({ req, res, reg, id }) => {
  req.resume();
  send(res, 200, await reg.resume(id));
};

const archive: Handler = async ({ req, res, reg, id }) => {
  req.resume();
  await reg.archive(id);
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
};

const briefing: Handler = ({ res, reg, id }) => send(res, 200, reg.briefing(id));

// ---- decisions --------------------------------------------------------------

const DECISION_ROUTE = /^\/api\/sessions\/([^/]+)\/decisions\/([0-9a-f]{16})$/;

/** A card answer: { action: allow (confirm? — required for high risk) | always | deny (message?) | answers (answers) | approve }. */
export function parseAnswer(body: unknown): Answer {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  switch (b.action) {
    case 'allow':
      if (b.confirm !== undefined && typeof b.confirm !== 'boolean') throw new HttpError(400, 'confirm must be a boolean');
      return b.confirm === true ? { action: 'allow', confirm: true } : { action: 'allow' };
    case 'always':
    case 'approve':
      return { action: b.action };
    case 'deny':
      if (b.message !== undefined && (typeof b.message !== 'string' || b.message.length > 2000)) throw new HttpError(400, 'message must be text');
      return b.message === undefined ? { action: 'deny' } : { action: 'deny', message: b.message };
    case 'answers': {
      const a = b.answers;
      if (typeof a !== 'object' || a === null || Array.isArray(a)) throw new HttpError(400, 'answers must be an object');
      const answers: Record<string, string> = {};
      for (const [k, v] of Object.entries(a)) {
        if (typeof v !== 'string') throw new HttpError(400, 'each answer must be text');
        answers[k] = v;
      }
      return { action: 'answers', answers };
    }
    default:
      throw new HttpError(400, 'action must be allow, always, deny, answers or approve');
  }
}

const decide = async ({ req, res, reg, id, url }: Ctx): Promise<void> => {
  const did = DECISION_ROUTE.exec(url.pathname)![2]!;
  const a = parseAnswer(await readJson(req, JSON_BODY_MAX));
  try {
    send(res, 200, reg.answer(id, did, a));
  } catch (e) {
    if (e instanceof GoneError) throw new HttpError(409, e.message);
    throw e;
  }
};

/** Per-session routes: "METHOD action" for /api/sessions/:id/<action>. */
const sessionRoutes: Record<string, Handler> = {
  'GET snapshot': snapshot,
  'GET term': term,
  'POST keys': keys,
  'POST resize': resize,
  'POST pause': pause,
  'POST resume': resume,
  'POST archive': archive,
  'GET briefing': briefing,
  'POST attachments': upload,
  'GET attachments': attachmentsList,
  'GET diff': reviewDiff,
  'GET tree': tree,
  'GET file': file,
  'GET raw': raw,
  'POST say': say,
};
const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)\/([a-z]+)$/;

// ---- routes ---------------------------------------------------------------

const createSession: Handler = async ({ req, res, reg }) => {
  const body = await readJson(req, JSON_BODY_MAX);
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof b.cwd !== 'string' || b.cwd.trim() === '') throw new HttpError(400, 'cwd is required');
  if (b.name !== undefined && typeof b.name !== 'string') throw new HttpError(400, 'name must be a string');
  if (b.isolate !== undefined && typeof b.isolate !== 'boolean') throw new HttpError(400, 'isolate must be a boolean');
  if (b.account !== undefined && (typeof b.account !== 'string' || b.account.length > PATH_MAX)) throw new HttpError(400, 'account must be a folder path');
  send(res, 201, reg.create({ cwd: b.cwd, name: b.name, isolate: b.isolate, ...(b.account !== undefined ? { account: b.account } : {}) }));
};

/** For the New session dialog's hint: is the folder a git repo with commits (so it gets a worktree)? Read-only. */
const repo: Handler = ({ res, url }) => {
  const p = url.searchParams.get('path');
  if (p === null || p.trim() === '' || p.length > PATH_MAX) throw new HttpError(400, `path is required (at most ${PATH_MAX} characters)`);
  const info = repoInfo(resolve(expandHome(p.trim())));
  send(res, 200, { git: info !== null, commits: info !== null && info.head !== null });
};

/** The macOS folder window for the New session dialog; waits until the user picks or cancels. */
const choose: Handler = async ({ req, res }) => {
  const body = await readJson(req, JSON_BODY_MAX);
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (b.start !== undefined && (typeof b.start !== 'string' || b.start.length > PATH_MAX)) throw new HttpError(400, 'start must be a path');
  const start = typeof b.start === 'string' && b.start.trim() !== '' ? resolve(expandHome(b.start.trim())) : undefined;
  send(res, 200, { path: await chooseFolder(start) });
};

/** Status line JSON from Tend's wrapper (context, cache, usage). Hook auth; stale launches are ignored. */
const STATUS_BODY_MAX = 64 * 1024;
const status: Handler = async ({ req, res, reg }) => {
  const sid = first(req.headers['x-tend-session']);
  let body: unknown;
  try {
    body = await readJson(req, STATUS_BODY_MAX);
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) throw e;
    body = undefined;
  }
  send(res, 200, {});
  if (body === undefined || !isSessionId(sid)) return;
  try {
    reg.status(sid, body, first(req.headers['x-tend-launch']));
  } catch (e) {
    logInternal('status', e);
  }
};

// ---- calm (v0.5) -------------------------------------------------------------

const getSettings: Handler = ({ res, settings }) => send(res, 200, settings.get());
const putSettings: Handler = async ({ req, res, settings, attention, sse }) => {
  const next = settings.update(await readJson(req, JSON_BODY_MAX));
  attention.tick(); // e.g. focus windows just turned off: release now
  send(res, 200, next);
  broadcast(sse, 'attention', attention.view());
};
const getAttention: Handler = ({ res, attention }) => send(res, 200, attention.view());
const showNow: Handler = ({ req, res, attention }) => {
  req.resume();
  attention.showNow();
  send(res, 200, attention.view());
};

/** Ask every working session to finish its step and stop: types one message into each (only on request). */
export const PARK_MESSAGE = 'Please finish the step you are on, then stop and say in one line where you are. (Tend: park everything)';
const park: Handler = ({ req, res, reg, socket, tmux }) => {
  req.resume();
  const working = parkable(reg.list(), (id) => tmux.snapshot(tmuxName(id)).toString('utf8'), Date.now());
  for (const v of working) {
    const client = acquire(socket, tmuxName(v.id));
    // bracketed paste, so the text arrives as one message; Enter queues it for when Claude can read it
    client.sendKeys(Buffer.from(`\x1b[200~${PARK_MESSAGE}\x1b[201~\r`));
    release(client);
  }
  send(res, 200, { asked: working.map((v) => v.id) });
};

const getWrapup: Handler = async ({ res, url, store }) => send(res, 200, await wrapupSince(store, Number(url.searchParams.get('since')), Date.now()));

const hook: Handler = async ({ req, res, reg }) => {
  const sid = first(req.headers['x-tend-session']);
  if (!isSessionId(sid) || !reg.get(sid)) {
    req.resume();
    send(res, 202, {});
    return;
  }
  let body: unknown;
  try {
    body = await readJson(req, HOOK_BODY_MAX);
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) throw e;
    body = undefined;
  }
  const launch = first(req.headers['x-tend-launch']);
  if (body !== undefined && (body as { hook_event_name?: unknown }).hook_event_name === 'PermissionRequest') {
    // held until a card answer or Claude closes it (answered in the terminal); never answered by Tend itself
    const held = {
      reply: (out: unknown): boolean => {
        if (res.writableEnded || res.destroyed) return false;
        send(res, 200, out);
        return true;
      },
    };
    let did: string | null = null;
    try {
      did = reg.hold(sid, body, launch, held);
    } catch (e) {
      logInternal('hook hold', e);
    }
    if (did === null) {
      send(res, 200, {}); // not a live launch: Claude falls back to its own dialog
      return;
    }
    const decision = did;
    if (res.destroyed) reg.decisionClosed(decision); // Claude dropped it while the body was read
    else
      res.on('close', () => {
        if (!res.writableEnded) reg.decisionClosed(decision);
      });
    return;
  }
  // every other hook is answered first, then processed
  send(res, 200, {});
  if (body === undefined) return;
  try {
    reg.ingest(sid, body, launch);
  } catch (e) {
    logInternal('hook ingest', e); // Claude already has its answer; nobody else would hear of this
  }
};

/** Route table: "METHOD /path" → handler. `open` routes skip authorisation; `hook` uses header-only auth. */
const routes: Record<string, { h: Handler; auth: 'open' | 'token' | 'hook' }> = {
  'GET /health': { h: ({ res, instance }) => send(res, 200, { ok: true, instance }), auth: 'open' },
  'GET /api/sessions': { h: ({ res, reg }) => send(res, 200, reg.list()), auth: 'token' },
  'POST /api/sessions': { h: createSession, auth: 'token' },
  'GET /api/repo': { h: repo, auth: 'token' },
  'POST /api/choose-folder': { h: choose, auth: 'token' },
  'POST /api/choose-folder/cancel': { h: ({ req, res }) => (req.resume(), send(res, 200, { cancelled: cancelFolderPanel() })), auth: 'token' },
  'GET /api/events': { h: events, auth: 'token' },
  'POST /hook': { h: hook, auth: 'hook' },
  'POST /status': { h: status, auth: 'hook' },
  'GET /api/usage': { h: ({ res, reg }) => send(res, 200, { accounts: reg.usage() }), auth: 'token' },
  'GET /api/settings': { h: getSettings, auth: 'token' },
  'PUT /api/settings': { h: putSettings, auth: 'token' },
  'GET /api/attention': { h: getAttention, auth: 'token' },
  'POST /api/attention/show': { h: showNow, auth: 'token' },
  'POST /api/park': { h: park, auth: 'token' },
  'GET /api/wrapup': { h: getWrapup, auth: 'token' },
  'GET /api/external': { h: listExternal, auth: 'token' },
  'POST /api/external/adopt': { h: adopt, auth: 'token' },
  'GET /api/compat': { h: ({ res, compat }) => send(res, 200, compat.view()), auth: 'token' },
  'POST /api/compat/selftest': {
    h: async ({ req, res, compat }) => {
      req.resume();
      if (compat.view().running) throw new HttpError(409, 'A self-test is already running.');
      send(res, 200, await compat.selfTest());
    },
    auth: 'token',
  },
};
for (const path of Object.keys(STATIC_FILES)) {
  routes[`GET ${path}`] = {
    h: async ({ res }) => {
      if (!(await serveStatic(res, path))) send(res, 404, { error: 'Not found' });
    },
    auth: 'token',
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, app: App): Promise<void> {
  const { token, hookToken, port } = app;
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    send(res, 400, { error: 'Bad request' });
    return;
  }
  const route = routes[`${req.method} ${url.pathname}`];
  const kind = route?.auth ?? 'token';
  if (kind !== 'open') {
    // Claude can't send cookies, and /hook must never accept a cookie or ?key=: header only.
    const headers =
      kind === 'hook'
        ? { origin: req.headers.origin, host: req.headers.host, 'x-tend-token': req.headers['x-tend-token'] }
        : req.headers;
    // /hook takes the hook token (or, for sessions started before v0.3, the UI token); nothing else takes the hook token
    let a = authorize({ headers, url: kind === 'hook' ? '/hook' : (req.url ?? '/') }, kind === 'hook' ? hookToken : token, port);
    if (!a.ok && kind === 'hook') a = authorize({ headers, url: '/hook' }, token, port);
    if (!a.ok) {
      req.resume();
      if (a.status === 401 && req.method === 'GET' && url.pathname === '/') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(SIGN_IN_PAGE);
        return;
      }
      send(res, a.status, { error: a.status === 401 ? 'Unauthorized' : 'Forbidden' });
      return;
    }
    if (a.setCookie) res.setHeader('set-cookie', a.setCookie);
  }
  let h = route?.h;
  let id = '';
  const am = route ? null : ATTACH_ROUTE.exec(url.pathname);
  if (am && req.method === 'GET' && isSessionId(am[1]) && app.reg.get(am[1])) {
    h = attachmentFile;
    id = am[1];
  }
  const dm = route || am ? null : DECISION_ROUTE.exec(url.pathname);
  if (dm && req.method === 'POST' && isSessionId(dm[1]) && app.reg.get(dm[1])) {
    h = decide;
    id = dm[1];
  }
  const m = route || dm || am ? null : SESSION_ROUTE.exec(url.pathname);
  if (m) {
    // ids are validated before any tmux use; unknown sessions are indistinguishable from malformed ones
    const sh = sessionRoutes[`${req.method} ${m[2]}`];
    if (sh && isSessionId(m[1]) && app.reg.get(m[1])) {
      h = sh;
      id = m[1];
    }
  }
  if (!h) {
    req.resume();
    send(res, 404, { error: 'Not found' });
    return;
  }
  try {
    await h({ ...app, req, res, url, id });
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.message });
    else if (e instanceof UserError) send(res, 400, { error: e.message });
    else {
      logInternal(`${req.method} ${url.pathname}`, e);
      send(res, 500, { error: 'Internal error' });
    }
  }
}

export async function startServer(o: {
  home: string;
  port: number;
  token: string;
  tmuxSocket: string;
  notifyMode: string;
  watchIntervalMs?: number;
  /** identity answered on /health (the lock file's nonce) */
  instance?: string;
}): Promise<{ close(): Promise<void>; setToken(t: string): void }> {
  const store = openStore(join(o.home, 'tend.sqlite'));
  const tmux = createTmux(o.tmuxSocket);
  tmux.ensureServerOptions(); // window-size manual on an already-running tmux server
  const mode: NotifyMode = o.notifyMode === 'osascript' || o.notifyMode === 'stub' ? o.notifyMode : 'off';
  const deliver = createNotifier({ mode, stubFile: join(o.home, 'notify.jsonl') });
  const settings = createSettings(o.home);
  const sse = new Set<ServerResponse>();
  let reg: Registry | undefined;
  // only notifications are held; a held "needs you" is dropped at release if it no longer does
  const attention = createAttention({
    settings: settings.get,
    deliver,
    stillRelevant: (h) => {
      const v = reg?.get(h.sessionId);
      if (h.kind === 'need') return v?.state.status === 'needs_you';
      if (h.kind === 'stuck') return Boolean(v?.stuck);
      if (h.kind === 'crash') return Boolean(v?.crashed);
      return true;
    },
    record: (kind, i) => store.addNotice(Date.now(), i.sessionId, kind, i.urgent === true),
    onChange: () => broadcast(sse, 'attention', attention.view()),
    ...heldFile(join(o.home, 'held.json')),
  });
  writeStatusShim(o.home); // running sessions' status lines follow this node and this package
  const compat = createCompat({ home: o.home, bin: claudeBin });
  void compat.refresh();
  const compatTimer = setInterval(() => void compat.refresh(), 3600_000); // Claude Code updates itself
  compatTimer.unref();
  const hookToken = loadOrCreateHookToken(o.home);
  reg = createRegistry({ store, tmux, home: o.home, port: o.port, token: hookToken, notify: (i) => attention.notify(i) });
  reg.onChange((v) => {
    if (v.state.status !== 'needs_you') attention.drop(v.id); // answered: its held ping is moot
  });

  reg.reconcile(Date.now());
  const watcher = setInterval(() => {
    try {
      reg.checkPanes();
    } catch {
      // a failed tmux probe must not kill the watcher; retry next tick
    }
    try {
      reg.checkTrust();
    } catch {
      // best effort; retry next tick
    }
    attention.tick();
  }, o.watchIntervalMs ?? 2000);
  watcher.unref();
  try {
    await reg.refreshGit({ silent: true }); // seed overlap and facts without notifying
  } catch {
    // facts are best effort
  }
  const gitTimer = setInterval(() => {
    reg.refreshGit().catch(() => undefined);
  }, GIT_REFRESH_MS);
  gitTimer.unref();

  const external = createExternal({ bin: claudeBin, accounts: listAccounts, homeClaude: HOME_CLAUDE(), own: () => new Set(store.listSessions().map((r) => r.claudeId)) });
  const app: App = { reg, external, sse, tmux, socket: o.tmuxSocket, token: o.token, hookToken, port: o.port, store, settings, attention, compat, instance: o.instance ?? '' };
  const debugHttp = process.env.TEND_DEBUG_HTTP === '1'; // one line per request (no tokens, no bodies) for diagnosis
  const server = createServer((req, res) => {
    if (debugHttp) {
      const t0 = Date.now();
      const path = (req.url ?? '').replace(/key=[^&]*/, 'key=…');
      process.stdout.write(`[http] > ${req.method} ${path} origin=${req.headers.origin ?? '-'} site=${req.headers['sec-fetch-site'] ?? '-'}\n`);
      res.on('close', () => process.stdout.write(`[http] < ${req.method} ${path} ${res.writableFinished ? res.statusCode : 'dropped'} ${Date.now() - t0}ms\n`));
    }
    handle(req, res, app).catch((e: unknown) => {
      logInternal('request', e);
      send(res, 500, { error: 'Internal error' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    /** A rotated UI token: old links stop working at once (hooks keep their own token). */
    setToken(t: string) {
      if (t === app.token) return;
      app.token = t;
      for (const c of app.sse) c.end(); // open tabs and terminal streams must reconnect with the new link
      app.sse.clear();
    },
    async close() {
      clearInterval(watcher);
      clearInterval(compatTimer);
      clearInterval(gitTimer);
      reg.close();
      stopFolderPanel();
      for (const c of app.sse) c.end();
      app.sse.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
