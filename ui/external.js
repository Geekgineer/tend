// @ts-check
// "Elsewhere": Claude sessions running outside tend, at the end of All sessions. Read-only rows; a closed one can be
// adopted (resumed under tend, in its folder). Tend never stops or types into a session it didn't start.
import { ApiError } from './api.js';
import { ago, esc, folderName, ICONS } from './list.js';

/**
 * @typedef {{ sessionId: string, name: string, cwd: string, kind: 'interactive' | 'background', status: string,
 *   startedAt: number, account: string, live: boolean, closedAt?: number, attachId?: string }} ExternalRow
 */
/** @typedef {import('./api.js').SessionResult} SessionResult */

const POLL_MS = 10_000;

/** @returns {Promise<ExternalRow[]>} */
async function fetchRows() {
  const r = await fetch('/api/external');
  if (!r.ok) throw new ApiError(r.status, 'Could not list sessions elsewhere');
  return r.json();
}

/** @param {string} sessionId @returns {Promise<SessionResult>} */
export async function adoptSession(sessionId) {
  const r = await fetch('/api/external/adopt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!r.ok) {
    let msg = `Could not adopt (${r.status})`;
    try {
      const b = await r.json();
      if (typeof b?.error === 'string') msg = b.error;
    } catch {
      // not JSON
    }
    throw new ApiError(r.status, msg);
  }
  return r.json();
}

/** One row's second line. @param {ExternalRow} r @param {number} now */
export function externalDetail(r, now = Date.now()) {
  if (!r.live) {
    const when = ago(r.closedAt ?? now, now);
    return `Closed ${when === 'now' ? 'just now' : `${when} ago`} · adopt to continue it here`;
  }
  const word = r.status === 'busy' ? 'Working' : r.status === 'idle' ? 'Idle' : r.status ? r.status[0].toUpperCase() + r.status.slice(1) : 'Open';
  if (r.kind === 'background') return `${word} · background · claude attach ${r.attachId ?? r.sessionId.slice(0, 8)}`;
  return `${word} · in its own terminal`;
}

/** @param {ExternalRow} r @param {boolean} busy @param {number} now */
function row(r, busy, now) {
  const icon = r.live ? (r.status === 'busy' ? ICONS.working : ICONS.idle) : ICONS.ended;
  const cls = r.live ? (r.status === 'busy' ? 'working' : 'idle') : 'closed';
  const act = r.live
    ? `<span class="xh" title="Close it in its own terminal (/exit) to adopt it here">open elsewhere</span>`
    : `<button class="xa" data-adopt="${esc(r.sessionId)}" ${busy ? 'disabled' : ''}>Adopt</button>`;
  return `<div class="row ext ${cls}" data-ext="${esc(r.sessionId)}" title="${esc(r.cwd)}">
<span class="g">${icon}</span><span class="n">${esc(r.name)} <span>· ${esc(folderName(r.cwd))}</span></span><span class="t">${act}</span>
<span class="a">${esc(externalDetail(r, now))}</span></div>`;
}

/**
 * @param {{ onChange: () => void, onAdopted: (v: SessionResult) => void, onError: (msg: string) => void, active: () => boolean }} o
 */
export function createElsewhere(o) {
  /** @type {ExternalRow[]} */
  let rows = [];
  let busy = '';
  let sig = '';

  async function load() {
    if (document.hidden || !o.active()) return;
    try {
      const next = await fetchRows();
      const s = JSON.stringify(next);
      if (s === sig) return;
      sig = s;
      rows = next;
      o.onChange();
    } catch {
      // best effort; the next poll tries again
    }
  }
  setInterval(load, POLL_MS);
  document.addEventListener('visibilitychange', () => void load());

  /** @param {string} sid */
  async function adopt(sid) {
    if (busy) return;
    busy = sid;
    o.onChange();
    try {
      const v = await adoptSession(sid);
      rows = rows.filter((r) => r.sessionId !== sid);
      sig = '';
      o.onAdopted(v);
    } catch (e) {
      o.onError(e instanceof Error ? e.message : 'Could not adopt that session.');
      sig = '';
      void load();
    } finally {
      busy = '';
      o.onChange();
    }
  }

  return {
    load,
    get count() {
      return rows.length;
    },
    /** Appends the section to the list (All sessions only). @param {HTMLElement} list */
    render(list) {
      if (!o.active() || rows.length === 0) return;
      const now = Date.now();
      const sec = document.createElement('section');
      sec.className = 'elsewhere';
      const closed = rows.filter((r) => !r.live).length;
      sec.innerHTML =
        `<div class="gh" title="Claude Code sessions started outside tend. Tend only lists them; close one there to adopt it here.">Elsewhere<span class="r">${closed ? `${closed} to adopt · ` : ''}${rows.length}</span></div>` +
        rows.map((r) => row(r, busy !== '', now)).join('');
      sec.querySelectorAll('[data-adopt]').forEach((b) =>
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          void adopt(/** @type {HTMLElement} */ (b).dataset.adopt ?? '');
        }),
      );
      list.append(sec);
    },
  };
}
