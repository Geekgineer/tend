// @ts-check
// Thin client for tend's /api routes. Auth rides on the HttpOnly `tend_token` cookie.

/** @typedef {'permission' | 'question' | 'plan' | 'trust'} Need */
/** @typedef {'starting' | 'working' | 'needs_you' | 'idle' | 'ended'} Status */
/** @typedef {{ status: Status, need?: Need, since: number, lastTool?: string }} SessionState */
/** @typedef {{ mode: 'inplace' } | { mode: 'worktree', branch: string, worktree: string }} Workspace */
/** @typedef {{ branch: string | null, ahead: number | null, behind: number | null, uncommitted: number, commits: number, changed: string[] }} GitFacts */
/** @typedef {{ files: string[], with: string[] }} Overlap */
/** @typedef {{ warm: boolean, expiresAt: number | null, recacheTokens: number | null }} CacheView */
/** @typedef {{ pct: number | null, tokens: number, size: number | null, model: string | null, cache: CacheView | null, at: number, stale?: true }} ContextView */
/** @typedef {{ pct: number, resetsAt: number, zone: 'chill' | 'on_pace' | 'warning' | 'hot', projected: number, confident: boolean, projection: string }} WindowView */
/** @typedef {{ focus: { enabled: boolean, minutes: number }, quiet: { enabled: boolean, start: string, end: string }, budgetPerHour: number, wipLimit: number }} Settings */
/** @typedef {{ held: { sessionId: string, title: string, body: string, at: number }[], nextRelease: number | null, quiet: boolean }} AttentionView */
/** @typedef {{ since: number, decisions: number, finished: number, started: number, interruptions: { sent: number, held: number }, waiting: number, commits: number }} Wrapup */
/** @typedef {{ dir: string, name: string, fiveHour: WindowView | null, sevenDay: WindowView | null, at: number | null, top: { id: string, name: string, share: number }[] }} AccountUsage */
/** @typedef {{ question: string, header: string, multiSelect: boolean, options: { label: string, description: string }[] }} Question */
/**
 * @typedef {{ id: string, kind: 'permission' | 'question' | 'plan', tool: string, createdAt: number,
 *   command?: string, description?: string, filePath?: string, url?: string,
 *   risk?: { level: 'high' | 'medium' | 'low', rule: string }, canAlways?: boolean, alwaysLabel?: string,
 *   questions?: Question[], terminalOnly?: boolean, plan?: string }} DecisionView
 */
/**
 * @typedef {{ id: string, name: string, cwd: string, state: SessionState, createdAt: number,
 *   workspace: Workspace, paused: boolean, archived?: true, git?: GitFacts, overlap?: Overlap,
 *   decisions?: DecisionView[], context?: ContextView, account: string,
 *   stuck?: { reason: 'repeating' | 'silent', tool?: string, error?: string, count?: number, since: number }, crashed?: true }} SessionView
 */
/** @typedef {SessionView & { warning?: string }} SessionResult */
/**
 * @typedef {{ goal: string | null, instructions: { ts: number, text: string }[],
 *   done: { ts: number, text: string, files: string[] }[], files: string[], working: string[],
 *   state: SessionState }} Briefing
 */

export class ApiError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {Response} r */
async function fail(r) {
  let msg = `Request failed (${r.status})`;
  try {
    const body = await r.json();
    if (body && typeof body.error === 'string') msg = body.error;
  } catch {
    // not JSON
  }
  return new ApiError(r.status, msg);
}

/** @param {string} id */
const sessionUrl = (id) => `/api/sessions/${encodeURIComponent(id)}`;

/** @param {string} b64 @returns {Uint8Array} */
export function decode(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @returns {Promise<SessionView[]>} */
export async function listSessions() {
  const r = await fetch('/api/sessions');
  if (!r.ok) throw await fail(r);
  return r.json();
}

/**
 * @param {string} cwd
 * @param {string} [name]
 * @param {boolean} [isolate] own worktree (the server's default) or the folder itself
 * @param {string} [account] a Claude config folder, or 'roomiest'; default: last used for this folder, else the default
 * @returns {Promise<SessionResult>}
 */
export async function createSession(cwd, name, isolate, account) {
  /** @type {{ cwd: string, name?: string, isolate?: boolean, account?: string }} */
  const body = { cwd };
  if (name !== undefined && name.trim() !== '') body.name = name.trim();
  if (isolate !== undefined) body.isolate = isolate;
  if (account) body.account = account;
  const r = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await fail(r);
  return r.json();
}

/**
 * Whether a folder is a git repo with commits (a session there gets its own worktree).
 * @param {string} path
 * @returns {Promise<{ git: boolean, commits: boolean }>}
 */
export async function repoInfo(path) {
  const r = await fetch(`/api/repo?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw await fail(r);
  return r.json();
}

/**
 * Open the macOS folder window on this machine, starting at `start`; resolves with the chosen
 * folder, or null if the user cancelled.
 * @param {string} start
 * @returns {Promise<string | null>}
 */
export async function chooseFolder(start) {
  const r = await fetch('/api/choose-folder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ start }),
  });
  if (!r.ok) throw await fail(r);
  return (await r.json()).path;
}

/** Close the folder window if it's open (e.g. hidden on another desktop); the pending choose resolves to null. */
export const cancelChooseFolder = () => fetch('/api/choose-folder/cancel', { method: 'POST' }).then(() => undefined, () => undefined);

/**
 * Answer a pending decision from its card.
 * @param {string} id @param {string} did @param {Record<string, unknown>} body
 * @returns {Promise<SessionView>}
 */
export async function decide(id, did, body) {
  const r = await fetch(`${sessionUrl(id)}/decisions/${encodeURIComponent(did)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await fail(r);
  return r.json();
}

/** @param {string} path @param {RequestInit} [init] */
async function json(path, init) {
  const r = await fetch(path, init);
  if (!r.ok) throw await fail(r);
  return r.json();
}
const send = (/** @type {string} */ method, /** @type {unknown} */ body = undefined) => ({ method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** @returns {Promise<Settings>} */
export const getSettings = () => json('/api/settings');
/** @param {unknown} s @returns {Promise<Settings>} */
export const saveSettings = (s) => json('/api/settings', send('PUT', s));
/** @returns {Promise<AttentionView>} */
export const attention = () => json('/api/attention');
/** @returns {Promise<AttentionView>} */
export const showNow = () => json('/api/attention/show', send('POST'));
/** @returns {Promise<{ asked: string[] }>} */
export const park = () => json('/api/park', send('POST'));
/** @param {number} [since] @returns {Promise<Wrapup>} */
export const wrapup = (since) => json(since ? `/api/wrapup?since=${since}` : '/api/wrapup');

/**
 * Attach one file to a session; its quoted path is pasted at the prompt (never sent).
 * @param {string} id @param {string} name @param {Blob} data
 * @returns {Promise<{ name: string, kind: string, bytes: number, insert: string, note?: string }>}
 */
export async function upload(id, name, data) {
  const r = await fetch(`${sessionUrl(id)}/attachments`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent(name) }, body: data });
  if (!r.ok) throw await fail(r);
  return r.json();
}
/** @param {string} id @returns {Promise<{ name: string, bytes: number, at: number }[]>} */
export const attachments = (id) => json(`${sessionUrl(id)}/attachments`);
/** @param {string} id @param {string} name */
export const attachmentUrl = (id, name) => `${sessionUrl(id)}/attachments/${encodeURIComponent(name)}`;
/** @param {string} id @param {string} path @param {boolean} [full] the whole file as context @returns {Promise<{ path: string, diff: string, truncated: boolean, binary: boolean }>} */
export const diff = (id, path, full = false) => json(`${sessionUrl(id)}/diff?path=${encodeURIComponent(path)}${full ? '&context=full' : ''}`);
/**
 * @typedef {{ path: string, status: 'A' | 'M' | 'D', add: number | null, del: number | null, fp: string }} ChangeView
 * @typedef {{ git: boolean, files: string[], truncated: boolean, changes: ChangeView[], changesTruncated?: true }} TreeView
 * @typedef {{ path: string, text: string, binary: boolean, truncated: boolean, size?: number, image?: true, fp?: string, missing?: true }} FileView
 */
/** The session folder's files and what changed. @param {string} id @returns {Promise<TreeView>} */
export const tree = (id) => json(`${sessionUrl(id)}/tree`);
/** A file now, or (`start`) as it was when the session began. @param {string} id @param {string} path @param {boolean} [start] @returns {Promise<FileView>} */
export const fileText = (id, path, start = false) => json(`${sessionUrl(id)}/file?path=${encodeURIComponent(path)}${start ? '&at=start' : ''}`);
/** Send a review to Claude (refused while Claude shows a dialog). @param {string} id @param {string} text */
export const say = (id, text) => json(`${sessionUrl(id)}/say`, send('POST', { text }));
/** An image in the session folder (for previews). @param {string} id @param {string} path */
export const rawUrl = (id, path) => `${sessionUrl(id)}/raw?path=${encodeURIComponent(path)}`;

/** Usage per account (Claude config folder). @returns {Promise<AccountUsage[]>} */
export async function usage() {
  const r = await fetch('/api/usage');
  if (!r.ok) throw await fail(r);
  return (await r.json()).accounts;
}

/** @param {string} id @returns {Promise<Briefing>} */
export async function briefing(id) {
  const r = await fetch(`${sessionUrl(id)}/briefing`);
  if (!r.ok) throw await fail(r);
  return r.json();
}

/** @param {string} id @param {'pause' | 'resume'} action @returns {Promise<SessionResult>} */
async function act(id, action) {
  const r = await fetch(`${sessionUrl(id)}/${action}`, { method: 'POST' });
  if (!r.ok) throw await fail(r);
  return r.json();
}

/** Free the worktree; the session ends and can be resumed. @param {string} id */
export const pause = (id) => act(id, 'pause');

/** Bring a paused or ended session back, same conversation. @param {string} id */
export const resume = (id) => act(id, 'resume');

/** Hide the session and free its worktree; the branch is kept. @param {string} id @returns {Promise<void>} */
export async function archive(id) {
  const r = await fetch(`${sessionUrl(id)}/archive`, { method: 'POST' });
  if (!r.ok) throw await fail(r);
}

/**
 * Live session list. The server sends a full `snapshot` on (re)connect, then one `session` per change.
 * @param {(views: SessionView[]) => void} onSnapshot
 * @param {(view: SessionView) => void} onSession
 * @returns {() => void} close
 */
export function events(onSnapshot, onSession, onAttention = /** @type {(a: AttentionView) => void} */ (() => {})) {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(/** @type {MessageEvent} */ (e).data)));
  es.addEventListener('session', (e) => onSession(JSON.parse(/** @type {MessageEvent} */ (e).data)));
  es.addEventListener('attention', (e) => onAttention(JSON.parse(/** @type {MessageEvent} */ (e).data)));
  return () => es.close();
}

/**
 * The visible screen as terminal bytes (clear, contents, cursor position).
 * @param {string} id
 * @returns {Promise<Uint8Array>}
 */
export async function snapshot(id) {
  const r = await fetch(`${sessionUrl(id)}/snapshot`);
  if (!r.ok) throw await fail(r);
  return decode(await r.text());
}

/**
 * Raw pane output. Never reconnects: a 404 or an ended stream closes it and calls `onEnd` once.
 * @param {string} id
 * @param {(bytes: Uint8Array) => void} onBytes
 * @param {{ onOpen?: () => void, onEnd?: () => void }} [hooks]
 * @returns {() => void} close
 */
export function stream(id, onBytes, hooks = {}) {
  const es = new EventSource(`${sessionUrl(id)}/term`);
  let closed = false;
  es.onopen = () => hooks.onOpen?.();
  es.onmessage = (e) => onBytes(decode(e.data));
  es.onerror = () => {
    // EventSource can't tell a 404 from a dropped stream, and would retry either forever.
    if (closed) return;
    closed = true;
    es.close();
    hooks.onEnd?.();
  };
  return () => {
    closed = true;
    es.close();
  };
}

/** One shared queue: keystrokes go out strictly one request at a time, in order. */
let keyQueue = Promise.resolve();

/** Per-request cap for /keys pastes; the server refuses bodies over 64 KB. */
export const KEYS_CHUNK_BYTES = 32 * 1024;

/**
 * Split `str` on code-point boundaries into pieces of at most `max` UTF-8 bytes.
 * @param {string} str
 * @param {number} [max]
 * @returns {string[]}
 */
export function chunkUtf8(str, max = KEYS_CHUNK_BYTES) {
  /** @type {string[]} */
  const out = [];
  let start = 0;
  let pos = 0;
  let size = 0;
  for (const ch of str) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (size + n > max && pos > start) {
      out.push(str.slice(start, pos));
      start = pos;
      size = 0;
    }
    size += n;
    pos += ch.length;
  }
  if (pos > start) out.push(str.slice(start, pos));
  return out;
}

/**
 * Send keystrokes or a paste. Large input goes out as several ordered requests through the
 * shared queue; the promise rejects with the first failure (later chunks are still tried).
 * @param {string} id
 * @param {string} str
 * @returns {Promise<void>}
 */
export function sendKeys(id, str) {
  const parts = chunkUtf8(str).map((body) => {
    const next = keyQueue.then(async () => {
      const r = await fetch(`${sessionUrl(id)}/keys`, { method: 'POST', body });
      if (!r.ok) throw await fail(r);
    });
    keyQueue = next.catch(() => {});
    return next;
  });
  return Promise.all(parts).then(() => {});
}

/**
 * @param {string} id
 * @param {number} cols
 * @param {number} rows
 * @returns {Promise<void>}
 */
export async function resize(id, cols, rows) {
  const r = await fetch(`${sessionUrl(id)}/resize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  });
  if (!r.ok) throw await fail(r);
}
