// @ts-check
// The Review tab's code views: a diff (unified or side by side, with word-level marks) and a whole file,
// both syntax-highlighted, with line comments. Rendering only: the controller (review.js) owns the state.
import { highlight } from './review-md.js';
import { inlineRange, langOf, splitHighlighted, splitRows } from './review-model.js';

/** @typedef {import('./review-model.js').Hunk} Hunk */
/** @typedef {import('./review-model.js').DiffLine} DiffLine */
/** @typedef {import('./review-model.js').Comment} Comment */
/** @typedef {{ side: 'old' | 'new', line: number, code: string }} LineRef */
/**
 * @typedef {{ path: string, comments: Comment[], onLine: (ref: LineRef, after: HTMLElement) => void,
 *   onDelete: (c: Comment) => void }} CodeOpts
 */

export const MAX_ROWS = 20_000;
/** Past these, colouring costs more than it gives (a minified file, a lockfile): plain text keeps the page responsive. */
export const COLOUR_MAX_CHARS = 300_000;
export const LINE_MAX = 2000;
/** A line cut at LINE_MAX, with what was left out. @param {string} t */
const cut = (t) => (t.length > LINE_MAX ? { text: t.slice(0, LINE_MAX), more: t.length - LINE_MAX } : { text: t, more: 0 });
/** @param {number} n */
const moreHtml = (n) => (n ? `<span class="rcut">… ${n.toLocaleString()} more characters</span>` : '');

// ---- small DOM and storage helpers (shared with review.js) ----
/** @param {string} tag @param {string} [cls] @param {string} [text] */
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
/** @param {string} text @param {string} [cls] @param {string} [title] */
export function button(text, cls = 'btn ghost sm', title) {
  const b = /** @type {HTMLButtonElement} */ (el('button', cls, text));
  b.type = 'button';
  if (title) b.title = title;
  return b;
}
/** @param {string} key @param {any} fallback */
export function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
/** @param {string} key @param {unknown} value */
export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {} // storage blocked: it just won't be remembered
}
export const typing = (/** @type {EventTarget | null} */ t) => !!(/** @type {HTMLElement | null} */ (t)?.closest?.('input, textarea, select, [contenteditable], .xterm'));


/** @param {string} full @param {string} lang @param {[number, number] | null} r */
function codeHtml(full, lang, r) {
  const { text, more } = cut(full);
  if (!r || r[1] > text.length) return highlight(text, lang) + moreHtml(more);
  return `${highlight(text.slice(0, r[0]), lang)}<mark>${highlight(text.slice(r[0], r[1]), lang)}</mark>${highlight(text.slice(r[1]), lang)}${moreHtml(more)}`;
}

/** A line-number cell that starts a comment on that line. @param {number | null} n @param {LineRef | null} ref @param {CodeOpts} o */
function gutter(n, ref, o) {
  const g = el('span', 'rn', n === null ? '' : String(n));
  if (ref) {
    g.classList.add('can');
    g.title = 'Comment on this line';
    g.addEventListener('click', () => o.onLine(ref, /** @type {HTMLElement} */ (g.closest('.rl, .rl2'))));
  }
  return g;
}

/** Comment cards under the row for `ref`. @param {HTMLElement} host @param {LineRef} ref @param {CodeOpts} o */
function cardsFor(host, ref, o) {
  for (const c of o.comments) {
    if (c.path !== o.path || c.side !== ref.side || c.line !== ref.line) continue;
    const card = el('div', 'rc');
    const del = /** @type {HTMLButtonElement} */ (el('button', 'btn ghost', 'Delete'));
    del.type = 'button';
    del.addEventListener('click', () => o.onDelete(c));
    card.append(el('span', 'rcwho', 'You'), el('p', '', c.text), del);
    host.append(card);
  }
}

/** @param {DiffLine} l @returns {LineRef} */
const refOf = (l) => (l.kind === '-' ? { side: 'old', line: /** @type {number} */ (l.old), code: l.text } : { side: 'new', line: /** @type {number} */ (l.new), code: l.text });

/**
 * A diff. `split` shows old and new side by side; between hunks, a bar shows the hidden lines (click: whole file).
 * @param {HTMLElement} host @param {Hunk[]} hunks @param {CodeOpts & { split: boolean, onExpand?: () => void }} o
 */
export function renderDiff(host, hunks, o) {
  let chars = 0;
  for (const h of hunks) for (const l of h.lines) chars += l.text.length;
  const lang = chars > COLOUR_MAX_CHARS ? '' : langOf(o.path);
  const frag = document.createDocumentFragment();
  let rows = 0;
  let prevEnd = 1;
  for (const [hi, h] of hunks.entries()) {
    const gap = h.oldStart - prevEnd;
    if (h.header && gap > 0) {
      const bar = el('button', 'rgap', `⋯ ${gap} unchanged line${gap === 1 ? '' : 's'}`);
      bar.setAttribute('type', 'button');
      if (o.onExpand) bar.addEventListener('click', o.onExpand);
      frag.append(bar);
    }
    const head = el('div', 'rh', h.header || `new file`);
    head.dataset.hunk = String(hi);
    frag.append(head);
    // word marks for a removed line that directly faces an added one
    /** @type {Map<DiffLine, [number, number] | null>} */
    const marks = new Map();
    for (const r of splitRows(h)) {
      if (r.left && r.right && r.left !== r.right) {
        const m = inlineRange(r.left.text, r.right.text);
        marks.set(r.left, m && m.a);
        marks.set(r.right, m && m.b);
      }
    }
    if (o.split) {
      for (const r of splitRows(h)) {
        if (++rows > MAX_ROWS) break;
        const row = el('div', 'rl2');
        for (const [side, l] of /** @type {const} */ ([['old', r.left], ['new', r.right]])) {
          const half = el('div', `half ${l === null ? 'none' : l.kind === ' ' ? '' : l.kind === '+' ? 'add' : 'del'}`);
          if (l) {
            const ref = l.kind === ' ' ? { side: /** @type {'new'} */ ('new'), line: /** @type {number} */ (l.new), code: l.text } : refOf(l);
            const n = side === 'old' ? l.old : l.new;
            const code = el('code');
            code.innerHTML = codeHtml(l.text, lang, marks.get(l) ?? null);
            half.append(gutter(n, side === 'old' && l.kind === ' ' ? null : ref, o), code);
          }
          row.append(half);
        }
        frag.append(row);
        /** @type {LineRef[]} */
        const refs = [];
        if (r.left && r.left.kind === '-') refs.push(refOf(r.left));
        if (r.right) refs.push(refOf(r.right)); // a context line is commented on its new-side number
        for (const ref of refs) cardsFor(/** @type {HTMLElement} */ (/** @type {unknown} */ (frag)), ref, o);
      }
    } else {
      for (const l of h.lines) {
        if (++rows > MAX_ROWS) break;
        const row = el('div', `rl ${l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : ''}`);
        const ref = refOf(l);
        const code = el('code');
        code.innerHTML = codeHtml(l.text, lang, marks.get(l) ?? null);
        row.append(gutter(l.old, ref, o), gutter(l.new, ref, o), el('span', 'rs', l.kind === ' ' ? '' : l.kind), code);
        frag.append(row);
        cardsFor(/** @type {HTMLElement} */ (/** @type {unknown} */ (frag)), ref, o);
      }
    }
    const last = h.lines.filter((l) => l.old !== null).pop();
    prevEnd = last?.old != null ? last.old + 1 : h.oldStart;
  }
  if (rows > MAX_ROWS) frag.append(el('p', 'rnote', `Showing the first ${MAX_ROWS.toLocaleString()} lines.`));
  host.replaceChildren(frag);
  host.classList.toggle('split', o.split);
}

/** A whole file, highlighted, with line numbers and comments. @param {HTMLElement} host @param {string} text @param {CodeOpts} o */
export function renderSource(host, text, o) {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const plain = body.split('\n');
  const colour = text.length <= COLOUR_MAX_CHARS && plain.every((l) => l.length <= LINE_MAX);
  const lines = colour ? splitHighlighted(highlight(body, langOf(o.path))) : plain.map((l) => { const c = cut(l); return highlight(c.text, '') + moreHtml(c.more); });
  const frag = document.createDocumentFragment();
  for (const [i, html] of lines.entries()) {
    if (i >= MAX_ROWS) {
      frag.append(el('p', 'rnote', `Showing the first ${MAX_ROWS.toLocaleString()} lines.`));
      break;
    }
    const ref = { side: /** @type {'new'} */ ('new'), line: i + 1, code: plain[i] ?? '' };
    const row = el('div', 'rl src');
    const code = el('code');
    code.innerHTML = html || ' ';
    row.append(gutter(i + 1, ref, o), code);
    frag.append(row);
    cardsFor(/** @type {HTMLElement} */ (/** @type {unknown} */ (frag)), ref, o);
  }
  host.replaceChildren(frag);
  host.classList.remove('split');
}

/**
 * The comment box under a line: ⌘Enter adds, Esc cancels.
 * @param {HTMLElement} after @param {LineRef} ref @param {{ onAdd: (text: string) => void, onCancel: () => void }} h
 */
export function composer(after, ref, h) {
  document.querySelector('.rcompose')?.remove();
  const box = el('div', 'rcompose');
  const ta = /** @type {HTMLTextAreaElement} */ (el('textarea'));
  ta.placeholder = `Comment on ${ref.side === 'old' ? 'removed ' : ''}line ${ref.line} for Claude…`;
  ta.rows = 3;
  ta.name = 'comment';
  const add = /** @type {HTMLButtonElement} */ (el('button', 'btn pri', 'Add comment'));
  const cancel = /** @type {HTMLButtonElement} */ (el('button', 'btn ghost', 'Cancel'));
  add.type = cancel.type = 'button';
  const done = () => box.remove();
  add.addEventListener('click', () => {
    if (!ta.value.trim()) return ta.focus();
    h.onAdd(ta.value);
    done();
  });
  cancel.addEventListener('click', () => {
    done();
    h.onCancel();
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation(); // j/k/n/p are letters here
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add.click();
    if (e.key === 'Escape') cancel.click();
  });
  const acts = el('div', 'acts');
  acts.append(el('span', 'hint', '⌘↵ to add'), cancel, add);
  box.append(ta, acts);
  after.after(box);
  ta.focus();
}
