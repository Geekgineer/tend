// @ts-check
// The selected session's header: name · state, one quiet line of git facts, and the session actions.
import { archive, pause, resume } from './api.js';
import { esc, fileList, ICONS, kind, OVERLAP_ICON, stateDetail } from './list.js';
import { contextFacts } from './usage.js';

/** @typedef {import('./api.js').SessionView} SessionView */
/** @typedef {import('./api.js').SessionResult} SessionResult */
/** @typedef {'pause' | 'resume' | 'archive'} Action */

/** @param {SessionView} v @returns {Action[]} */
export function actionsFor(v) {
  /** @type {Action[]} */
  const out = [];
  if (v.workspace.mode === 'worktree' && !v.paused) out.push('pause');
  if (v.paused || v.state.status === 'ended') out.push('resume');
  out.push('archive');
  return out;
}

const ACTION_LABEL = { pause: 'Pause', resume: 'Resume', archive: 'Archive' };
const ACTION_TITLE = {
  pause: 'Commit work in progress and free the worktree; resume later',
  resume: 'Continue the same Claude conversation',
  archive: 'Hide this session and remove its worktree; the branch is kept',
};

/** @param {SessionView} v @returns {string | null} */
const branchOf = (v) => v.git?.branch ?? (v.workspace.mode === 'worktree' ? v.workspace.branch : null);

/**
 * The facts line: each item only when there is something to say.
 * @param {SessionView} v
 * @param {(id: string) => string} nameOf
 */
function facts(v, nameOf) {
  /** @type {string[]} */
  const out = [];
  const g = v.git;
  const branch = branchOf(v);
  if (branch) out.push(`<span><code>${esc(branch)}</code></span>`);
  if (g && v.workspace.mode === 'worktree' && g.commits > 0) {
    out.push(`<span class="num" title="Commits since the session started">↑${g.commits}</span>`);
  } else if (g && g.ahead !== null && g.behind !== null && (g.ahead > 0 || g.behind > 0)) {
    out.push(`<span class="num" title="Ahead / behind upstream">↑${g.ahead} ↓${g.behind}</span>`);
  }
  if (g && g.uncommitted > 0) out.push(`<span class="num">●${g.uncommitted} uncommitted</span>`);
  out.push(
    v.workspace.mode === 'worktree'
      ? `<span class="badge" title="${esc(v.workspace.worktree)}">worktree</span>`
      : `<span class="badge" title="${esc(v.cwd)}">in place</span>`,
  );
  for (const f of contextFacts(v.context, Date.now())) {
    out.push(`<span class="num${f.cls ? ` ${f.cls}` : ''}"${f.title ? ` title="${esc(f.title)}"` : ''}>${esc(f.text)}</span>`);
  }
  if (v.overlap) {
    const who = v.overlap.with.map(nameOf).join(', ');
    const text = `Overlaps ${who}: ${fileList(v.overlap.files)}`;
    out.push(`<span class="ovl" title="${esc(`Overlaps ${who}: ${v.overlap.files.join(', ')}`)}">${OVERLAP_ICON}${esc(text)}</span>`);
  }
  return out.join('');
}

/**
 * @param {HTMLElement} dh
 * @param {SessionView | undefined} v
 * @param {(id: string) => string} nameOf
 * @param {(id: string, a: Action) => boolean} isBusy
 */
export function renderHeader(dh, v, nameOf, isBusy) {
  if (!v) {
    dh.innerHTML = '';
    return;
  }
  const k = kind(v);
  dh.className = `dh ${k}`;
  const buttons = actionsFor(v)
    .map((a) => `<button class="btn sm" data-act="${a}" title="${ACTION_TITLE[a]}"${isBusy(v.id, a) ? ' disabled' : ''}>${ACTION_LABEL[a]}</button>`)
    .join('');
  dh.innerHTML = `<div class="l1"><span class="g">${ICONS[k]}</span><h1 title="${esc(v.cwd)}">${esc(v.name)}</h1><span class="sep">·</span><span class="st">${esc(stateDetail(v))}</span><span class="acts">${buttons}</span></div>
<div class="facts">${facts(v, nameOf)}</div>`;
}

/** @param {SessionView} v */
export function archiveQuestion(v) {
  if (v.workspace.mode !== 'worktree') return `Archive ${v.name}?`;
  const q = `Archive ${v.name}? Its worktree is removed; the branch ${v.workspace.branch} is kept.`;
  return v.paused ? `${q} Set-aside ignored files stay in ~/.tend/paused/${v.id}.` : q;
}

/**
 * Click handling for the header buttons. One request per session+action at a time.
 * @param {HTMLElement} dh
 * @param {{
 *   current: () => SessionView | undefined,
 *   busy: Set<string>,
 *   notice: (msg: string) => void,
 *   applied: (v: SessionResult, a: Action) => void,
 *   archived: (id: string) => void,
 *   rerender: () => void,
 * }} deps
 */
export function wireActions(dh, deps) {
  dh.addEventListener('click', async (e) => {
    const b = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest('[data-act]') : null);
    const v = deps.current();
    if (!b || !v) return;
    const a = /** @type {Action} */ (b.dataset.act);
    const key = `${v.id}:${a}`;
    if (deps.busy.has(key)) return;
    if (a === 'archive' && !confirm(archiveQuestion(v))) return;
    deps.busy.add(key);
    deps.rerender();
    try {
      if (a === 'archive') {
        await archive(v.id);
        deps.archived(v.id);
      } else {
        const r = await (a === 'pause' ? pause(v.id) : resume(v.id));
        deps.applied(r, a);
        if (r.warning) deps.notice(r.warning);
      }
    } catch (x) {
      deps.notice(x instanceof Error ? x.message : `Could not ${a} the session.`);
    } finally {
      deps.busy.delete(key);
      deps.rerender();
    }
  });
}
