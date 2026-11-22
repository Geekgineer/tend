// @ts-check
// Media into a session (spec §6.1): paste, drop or attach; each file becomes a path at Claude's prompt (never
// sent). The bar above the terminal also carries the Terminal | Review tabs. textContent only.
import { attachmentUrl, attachments, upload } from './api.js';

/** @typedef {import('./api.js').SessionView} SessionView */

const IMAGE = /\.(png|jpe?g|webp)$/i;

/** Files from a paste or drop event (images pasted from the clipboard included). @param {DataTransfer | null} dt */
export function filesOf(dt) {
  if (!dt) return [];
  const out = /** @type {File[]} */ ([]);
  for (const f of Array.from(dt.files ?? [])) out.push(f);
  if (!out.length) for (const it of Array.from(dt.items ?? [])) if (it.kind === 'file') {
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

/**
 * Should Tend take this paste as an attachment? Only with files on the clipboard, never into a text field
 * (folder, name, note), and not when it also carries text but no real files (copied spreadsheet cells come
 * with a picture of themselves).
 * @param {DataTransfer | null} dt @param {Element | null} active
 */
export function takesPaste(dt, active) {
  if (!dt) return false;
  const field = active && (active.closest?.('input, textarea, [contenteditable]') ?? null);
  const inTerminal = active?.classList?.contains('xterm-helper-textarea') ?? false;
  if (field && !inTerminal) return false;
  const files = filesOf(dt);
  if (Array.from(dt.types ?? []).includes('text/plain')) {
    // copied cells or slides come as text plus a picture of themselves ("image.png"): the text is what was meant
    if (!files.length || files.every((f) => f.type?.startsWith('image/') && (!f.name || f.name === 'image.png'))) return false;
  }
  return files.length > 0;
}

/** A name for a pasted image that came without one. @param {File} f @param {Date} [now] */
export function nameFor(f, now = new Date()) {
  if (f.name && f.name !== 'image.png') return f.name;
  const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return `screenshot-${now.toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`;
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {{ bar: HTMLElement, term: HTMLElement, list: HTMLElement, tabs: HTMLElement }} els
 * @param {{ current: () => SessionView | undefined, notice: (msg: string) => void, focusTerminal: () => void }} hooks
 */
export function createMedia({ bar, term, list, tabs }, hooks) {
  /** @type {SessionView | undefined} */
  let view;
  let shownFor = '';
  const input = /** @type {HTMLInputElement} */ (el('input'));
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  document.body.append(input);

  /** @param {string} id @param {File[]} files */
  async function send(id, files) {
    for (const f of files) {
      try {
        const r = await upload(id, nameFor(f), f);
        hooks.notice(`Attached ${r.name}${r.note ? ` (${r.note})` : ''}`);
      } catch (x) {
        hooks.notice(x instanceof Error ? x.message : `Could not attach ${f.name}`);
      }
    }
    if (id === view?.id) {
      shownFor = '';
      void refresh();
      hooks.focusTerminal();
    }
  }
  input.addEventListener('change', () => {
    if (view && input.files?.length) void send(view.id, Array.from(input.files));
    input.value = '';
  });

  // paste: an image or file on the clipboard goes to the selected session (text pastes are the terminal's)
  document.addEventListener('paste', (e) => {
    if (!takesPaste(e.clipboardData, document.activeElement)) return;
    const files = filesOf(e.clipboardData);
    if (!files.length || !view || view.paused || view.state.status === 'ended') return;
    e.preventDefault();
    e.stopPropagation();
    void send(view.id, files);
  }, true);

  // drop onto the terminal pane: attach to the selected session
  const overlay = el('div', 'dropover');
  overlay.hidden = true;
  term.append(overlay);
  let depth = 0;
  term.addEventListener('dragenter', (e) => {
    if (!view || !e.dataTransfer?.types.includes('Files')) return;
    depth++;
    overlay.textContent = `Drop to attach to ${view.name}`;
    overlay.hidden = false;
  });
  term.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      overlay.hidden = true;
    }
  });
  term.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  term.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = filesOf(e.dataTransfer);
    if (view && files.length) void send(view.id, files);
  });
  // drop onto a list row: attach to that session without switching
  list.addEventListener('dragover', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest?.('[data-id]');
    if (row && e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      row.classList.add('droptarget');
    }
  });
  list.addEventListener('dragleave', (e) => /** @type {HTMLElement} */ (e.target).closest?.('[data-id]')?.classList.remove('droptarget'));
  list.addEventListener('drop', (e) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest?.('[data-id]'));
    if (!row?.dataset.id) return;
    e.preventDefault();
    row.classList.remove('droptarget');
    const files = filesOf(e.dataTransfer);
    if (files.length) void send(row.dataset.id, files);
  });

  async function refresh() {
    if (!view) {
      bar.hidden = true;
      return;
    }
    const v = view;
    bar.hidden = false;
    const attach = /** @type {HTMLButtonElement} */ (el('button', 'btn ghost', 'Attach'));
    attach.type = 'button';
    attach.title = 'Attach images, PDFs or files (or paste / drop them here)';
    attach.disabled = v.paused || v.state.status === 'ended';
    attach.addEventListener('click', () => input.click());
    const chips = el('div', 'chips');
    bar.replaceChildren(tabs, chips, attach);
    try {
      const list = await attachments(v.id);
      if (view?.id !== v.id) return;
      chips.replaceChildren(...list.slice(0, 12).map((a) => {
        const c = /** @type {HTMLAnchorElement} */ (el('a', 'chip'));
        c.href = attachmentUrl(v.id, a.name);
        c.target = '_blank';
        c.rel = 'noopener';
        c.title = a.name;
        if (IMAGE.test(a.name)) {
          const img = /** @type {HTMLImageElement} */ (el('img'));
          img.src = c.href;
          img.alt = '';
          c.append(img);
        }
        c.append(el('span', '', a.name.replace(/^\d{8}-\d{4}-/, '')));
        return c;
      }));
    } catch {
      // no attachments yet, or the session is gone
    }
  }

  return {
    /** Open the file picker for the selected session. */
    attach: () => {
      if (view && !view.paused && view.state.status !== 'ended') input.click();
    },
    /** @param {SessionView | undefined} v */
    update(v) {
      view = v;
      const key = v ? `${v.id}|${v.paused}|${v.state.status === 'ended'}` : '';
      if (key === shownFor) return;
      shownFor = key;
      void refresh();
    },
  };
}
