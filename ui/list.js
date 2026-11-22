// @ts-check
// Fleet strip and session list. State is shown by shape first, colour second.
import { summary } from './decision.js';
import { ringHTML } from './usage.js';

/** @typedef {import('./api.js').SessionView} SessionView */

const svg = (/** @type {string} */ body, fill = false) =>
  `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.7"'}>${body}</svg>`;

/** Icons by kind: lock = permission, ? = question, clipboard = plan, shield = trust, bars = working, pause = idle, pause in a square = paused. */
export const ICONS = {
  permission: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>'),
  question: svg('<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3"/><circle cx="8" cy="11.4" r=".5" fill="currentColor"/>'),
  plan: svg('<rect x="3.5" y="3" width="9" height="11" rx="1.5"/><path d="M6 3V2.2h4V3M6 7h4M6 9.5h4M6 12h2"/>'),
  trust: svg('<path d="M8 1.8l5 1.9v4c0 3-2.1 5.3-5 6.5-2.9-1.2-5-3.5-5-6.5v-4z"/>'),
  working: svg('<rect x="3" y="6" width="2.2" height="4" rx="1.1"/><rect x="6.9" y="3.5" width="2.2" height="9" rx="1.1"/><rect x="10.8" y="5" width="2.2" height="6" rx="1.1"/>', true),
  idle: svg('<circle cx="8" cy="8" r="5.5"/><path d="M6.6 6v4M9.4 6v4"/>'),
  starting: svg('<circle cx="8" cy="8" r="5.5" stroke-dasharray="2.4 2.2"/>'),
  ended: svg('<rect x="4" y="4" width="8" height="8" rx="1.5"/>'),
  paused: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M6.6 6v4M9.4 6v4"/>'),
};

/** Two offset squares: this session changed files another session also changed. */
export const OVERLAP_ICON = svg('<rect x="2.5" y="2.5" width="7.5" height="7.5" rx="1.5"/><rect x="6" y="6" width="7.5" height="7.5" rx="1.5"/>');

/** @param {SessionView} v @returns {keyof ICONS} */
export function kind(v) {
  if (v.paused) return 'paused';
  const s = v.state.status;
  if (s === 'needs_you') return v.state.need ?? 'permission';
  return s;
}

const NEED_TEXT = {
  permission: 'wants permission',
  question: 'has a question',
  plan: 'has a plan to review',
  trust: 'asks you to trust the folder',
};
const LABEL = { starting: 'Starting', working: 'Working', needs_you: 'Needs you', idle: 'Idle', ended: 'Ended' };

/** @param {SessionView} v */
export const stateLabel = (v) => (v.paused ? 'Paused' : LABEL[v.state.status]);

/** One line on what the session is doing, in plain words. @param {SessionView} v */
export function stateDetail(v) {
  const s = v.state;
  if (v.paused) return 'Paused';
  if (s.status === 'needs_you') return `Needs you · ${NEED_TEXT[s.need ?? 'permission']}`;
  if (s.status === 'working') return s.lastTool ? `Working · ${s.lastTool}` : 'Working';
  return LABEL[s.status];
}

/** @param {string} s */
export const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** @param {string} cwd */
export const folderName = (cwd) => cwd.replace(/\/+$/, '').split('/').pop() || cwd;

/** Recent distinct session folders, newest first. @param {{ cwd: string, createdAt: number }[]} views @param {number} [max] */
export function recentFolders(views, max = 5) {
  const out = /** @type {string[]} */ ([]);
  for (const v of [...views].sort((a, b) => b.createdAt - a.createdAt)) {
    if (!out.includes(v.cwd)) out.push(v.cwd);
    if (out.length === max) break;
  }
  return out;
}

/** @param {number} since @param {number} [now] */
export function ago(since, now = Date.now()) {
  const m = Math.floor((now - since) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const ORDER = { needs_you: 0, working: 1, starting: 2, idle: 3, ended: 4 };
/** @param {SessionView} a @param {SessionView} b */
const byAttention = (a, b) =>
  ORDER[a.state.status] - ORDER[b.state.status] ||
  (a.state.status === 'needs_you' ? a.state.since - b.state.since : b.createdAt - a.createdAt);

/** @param {SessionView} v */
const needsYou = (v) => v.state.status === 'needs_you' && !v.paused;

/** Sessions that need you, longest waiting first. @param {SessionView[]} views */
const waiting = (views) => views.filter(needsYou).sort((a, b) => a.state.since - b.state.since);

/** Problems: still going, but overlapping another session's files. @param {SessionView[]} views */
const problems = (views) => views.filter((v) => !needsYou(v) && (v.overlap || v.stuck || v.crashed)).sort((a, b) => b.createdAt - a.createdAt);

/** The row text for a problem (stuck, crashed), or null. @param {SessionView} v */
export function problemText(v) {
  if (v.crashed) return 'Ended unexpectedly';
  if (v.stuck) return v.stuck.reason === 'silent' ? 'Stuck · no progress for 10 min' : `Stuck · same ${v.stuck.tool} error ${v.stuck.count}×`;
  return null;
}

/** "For you": what needs you, then problems. @param {SessionView[]} views */
export const forYou = (views) => [...waiting(views), ...problems(views)];

/** The branch for a row, without tend's `tend/` prefix. @param {SessionView} v */
export function shortBranch(v) {
  const b = v.git?.branch ?? (v.workspace.mode === 'worktree' ? v.workspace.branch : null);
  return b ? b.replace(/^tend\//, '') : null;
}

/**
 * "a.ts, b.ts, c.ts, +2 more"
 * @param {string[]} files
 */
export function fileList(files) {
  const head = files.slice(0, 3).join(', ');
  return files.length > 3 ? `${head}, +${files.length - 3} more` : head;
}

/** @param {SessionView[]} views @returns {[string, SessionView[]][]} */
function byFolder(views) {
  /** @type {Map<string, SessionView[]>} */
  const groups = new Map();
  for (const v of [...views].sort(byAttention)) {
    const k = folderName(v.cwd);
    groups.set(k, [...(groups.get(k) ?? []), v]);
  }
  return [...groups.entries()];
}

/** @param {HTMLElement} el @param {(id: string) => void} onSelect */
function wire(el, onSelect) {
  el.querySelectorAll('[data-id]').forEach((b) =>
    b.addEventListener('click', () => onSelect(/** @type {HTMLElement} */ (b).dataset.id ?? '')),
  );
}

/**
 * Tiles grouped by folder. Ended sessions are left out: the strip is for what's alive.
 * @param {HTMLElement} el
 * @param {SessionView[]} views
 * @param {string | null} selectedId
 * @param {(id: string) => void} onSelect
 */
export function renderStrip(el, views, selectedId, onSelect) {
  const live = views.filter((v) => v.state.status !== 'ended');
  el.innerHTML = byFolder(live)
    .map(
      ([folder, vs]) =>
        `<div class="sg"><span class="pl">${esc(folder)}</span><div class="ts">${vs
          .map((v) => {
            const k = kind(v);
            const title = `${v.name} · ${stateDetail(v)}`;
            return `<button class="tile ${k}${v.overlap ? ' ovl' : ''}${v.id === selectedId ? ' sel' : ''}" data-id="${esc(v.id)}" title="${esc(title)}" aria-label="${esc(title)}">${ICONS[k]}</button>`;
          })
          .join('')}</div></div>`,
    )
    .join('');
  wire(el, onSelect);
}

/**
 * @param {SessionView} v
 * @param {string | null} selectedId
 * @param {boolean} showFolder
 * @param {number} now
 */
function row(v, selectedId, showFolder, now) {
  const k = kind(v);
  const attn = needsYou(v) || v.overlap !== undefined || v.stuck !== undefined || v.crashed === true;
  const folder = showFolder ? ` <span>· ${esc(folderName(v.cwd))}</span>` : '';
  const br = shortBranch(v);
  const branch = br ? `<code class="br">${esc(br)}</code>` : '';
  const ovl = v.overlap ? `<span class="ob" title="${esc(`Overlaps: ${fileList(v.overlap.files)}`)}">${OVERLAP_ICON}</span>` : '';
  return `<button class="row ${k}${attn ? ' attn' : ''}${v.id === selectedId ? ' on' : ''}" data-id="${esc(v.id)}">
<span class="g">${ICONS[k]}</span><span class="n">${esc(v.name)}${folder}</span><span class="t num">${ovl}${ringHTML(v.context)}${ago(v.state.since, now)}</span>
<span class="a">${esc(v.decisions?.[0] ? summary(v.decisions[0]) : problemText(v) ?? stateDetail(v))}${branch}</span></button>`;
}

/**
 * @param {HTMLElement} el
 * @param {SessionView[]} views
 * @param {'you' | 'all'} mode
 * @param {string | null} selectedId
 * @param {(id: string) => void} onSelect
 */
export function renderList(el, views, mode, selectedId, onSelect) {
  const now = Date.now();
  if (mode === 'you') {
    const q = waiting(views);
    const p = problems(views);
    const need = q.length
      ? `<div class="gh need">Waiting on you<span class="r">${q.length}</span></div>` + q.map((v) => row(v, selectedId, true, now)).join('')
      : '';
    const prob = p.length
      ? `<div class="gh">Problems<span class="r">${p.length}</span></div>` + p.map((v) => row(v, selectedId, true, now)).join('')
      : '';
    el.innerHTML =
      need + prob || `<div class="empty"><b>Nothing needs you</b>When a session asks for something, it shows up here.</div>`;
  } else {
    el.innerHTML = byFolder(views)
      .map(([folder, vs]) => {
        const n = vs.filter(needsYou).length;
        const count = n ? `<span class="need">${n} for you</span> · ${vs.length}` : String(vs.length);
        return `<div class="gh">${esc(folder)}<span class="r">${count}</span></div>` + vs.map((v) => row(v, selectedId, false, now)).join('');
      })
      .join('');
  }
  wire(el, onSelect);
}

/**
 * Counts for the top bar.
 * @param {HTMLElement} el
 * @param {SessionView[]} views
 */
export function renderSummary(el, views) {
  const n = (/** @type {string} */ s) => views.filter((v) => !v.paused && v.state.status === s).length;
  const you = n('needs_you');
  const paused = views.filter((v) => v.paused).length;
  const ovl = views.filter((v) => v.overlap).length;
  const parts = [`${n('working')} working`, `${n('idle')} idle`];
  if (n('starting')) parts.push(`${n('starting')} starting`);
  if (paused) parts.push(`${paused} paused`);
  const head = you ? `<span><b>${you} for you</b></span>` : ovl ? '' : '<span>All clear</span>';
  const over = ovl ? `<span class="ovl">${ovl} overlapping</span>` : '';
  el.innerHTML = views.length === 0 ? '' : head + over + parts.map((p) => `<span>${p}</span>`).join('');
}
