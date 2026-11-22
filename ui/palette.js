// @ts-check
// The ⌘K palette: jump to a session or run an action by typing a few letters. textContent only.

/** @typedef {{ id: string, label: string, hint?: string, run: () => void }} Item */

/**
 * Fuzzy score: every query character in order (case-insensitive), earlier and adjacent matches score higher.
 * -1 when it doesn't match. @param {string} query @param {string} text
 */
export function score(query, text) {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  let at = -1;
  let s = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const i = t.indexOf(ch, at + 1);
    if (i < 0) return -1;
    s += i === at + 1 ? 3 : 1;
    if (i === 0 || /[\s\-_/.]/.test(t[i - 1] ?? '')) s += 2;
    at = i;
  }
  return s - at * 0.01;
}

/** Items matching the query, best first (all of them, in order, for an empty query). @param {Item[]} items @param {string} q */
export function filter(items, q) {
  if (!q.trim()) return items;
  return items
    .map((it) => ({ it, s: Math.max(score(q, it.label), score(q, `${it.label} ${it.hint ?? ''}`) - 1) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it);
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** @param {() => Item[]} items @param {{ placeholder?: string, label?: string }} [o] */
export function createPalette(items, o = {}) {
  /** @type {HTMLDialogElement | null} */
  let dlg = null;

  function open() {
    if (dlg) return;
    const all = items();
    dlg = /** @type {HTMLDialogElement} */ (el('dialog', 'palette'));
    dlg.setAttribute('aria-label', o.label ?? 'Command palette');
    const input = /** @type {HTMLInputElement} */ (el('input'));
    input.placeholder = o.placeholder ?? 'Jump to a session or run an action…';
    input.setAttribute('aria-label', 'Search');
    const list = el('ul', 'plist');
    list.setAttribute('role', 'listbox');
    let sel = 0;
    /** @type {Item[]} */
    let shown = all;
    const draw = () => {
      shown = filter(all, input.value).slice(0, 50);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((it, i) => {
        const li = el('li', i === sel ? 'on' : '');
        li.setAttribute('role', 'option');
        li.append(el('span', 'plabel', it.label));
        if (it.hint) li.append(el('span', 'phint', it.hint));
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          run(it);
        });
        return li;
      }));
      if (!shown.length) list.append(el('li', 'pnone', 'Nothing matches'));
    };
    /** @param {Item} it */
    const run = (it) => {
      close();
      it.run();
    };
    input.addEventListener('input', () => {
      sel = 0;
      draw();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') sel = Math.min(sel + 1, shown.length - 1);
      else if (e.key === 'ArrowUp') sel = Math.max(sel - 1, 0);
      else if (e.key === 'Enter' && shown[sel]) {
        e.preventDefault();
        run(shown[sel]);
        return;
      } else return;
      e.preventDefault();
      draw();
    });
    dlg.addEventListener('close', () => {
      dlg?.remove();
      dlg = null;
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) close();
    });
    dlg.append(input, list);
    document.body.append(dlg);
    draw();
    dlg.showModal();
    input.focus();
  }
  function close() {
    dlg?.close();
  }
  return { open, close, get isOpen() { return dlg !== null; } };
}
