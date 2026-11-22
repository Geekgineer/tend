// @ts-check
// The briefing: what the session was asked, what it did, which files it touched. Built from events
// only, so every string here is untrusted: nodes are made with createElement and filled with textContent.
import { ago } from './list.js';

/** @typedef {import('./api.js').Briefing} Briefing */

const LIMIT = 5;

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** @param {string} title @param {...HTMLElement} body */
function section(title, ...body) {
  const s = el('section');
  s.append(el('h4', undefined, title), ...body);
  return s;
}

/** @param {string[]} files */
function fileCodes(files) {
  return files.map((f) => el('code', undefined, f));
}

/** @param {HTMLElement[]} items */
function list(items) {
  const ul = el('ul');
  ul.append(...items);
  return ul;
}

/**
 * Render (or clear, for `null`) the briefing into a `<details>` element.
 * The "show all" choice for Done survives re-renders via `data-all`.
 * @param {HTMLElement} root
 * @param {Briefing | null} b
 */
export function renderBriefing(root, b) {
  root.hidden = b === null;
  if (b === null) {
    root.replaceChildren();
    return;
  }
  const now = Date.now();

  const summary = el('summary');
  summary.append(el('span', 'lab', 'Briefing'), el('span', 'one', b.goal ?? (b.done.at(-1)?.text || 'Nothing yet')), el('span', 'chev', '⌄'));

  const body = el('div', 'bbody');
  if (b.goal) body.append(section('Goal', el('p', 'goal', b.goal)));
  const grid = el('div', 'bgrid');

  if (b.done.length) {
    const all = root.dataset.all === '1';
    const done = [...b.done].reverse();
    const shown = all ? done : done.slice(0, LIMIT);
    const items = shown.map((d) => {
      const li = el('li');
      li.append(el('span', 'ago num', ago(d.ts, now)), el('span', 'tx', d.text || 'Finished a turn'));
      if (d.files.length) {
        const fs = el('span', 'fs');
        fs.append(...fileCodes(d.files));
        li.append(fs);
      }
      return li;
    });
    const parts = [list(items)];
    if (done.length > LIMIT) {
      const more = /** @type {HTMLButtonElement} */ (el('button', 'more', all ? 'Show fewer' : `Show all ${done.length}`));
      more.type = 'button';
      more.addEventListener('click', () => {
        root.dataset.all = all ? '' : '1';
        renderBriefing(root, b);
      });
      parts.push(more);
    }
    grid.append(section('Done', ...parts));
  }

  if (b.working.length) {
    const fs = el('div', 'fl');
    fs.append(...fileCodes(b.working));
    grid.append(section('Working on', fs));
  }

  if (b.instructions.length) {
    const items = [...b.instructions].reverse().slice(0, LIMIT).map((i) => {
      const li = el('li');
      li.append(el('span', 'ago num', ago(i.ts, now)), el('span', 'tx', i.text));
      return li;
    });
    grid.append(section('Your instructions', list(items)));
  }

  if (b.files.length) {
    const h = el('div', 'fl');
    h.append(...fileCodes(b.files));
    grid.append(section(`Files edited · ${b.files.length}`, h));
  }

  if (grid.children.length) body.append(grid);
  if (body.children.length) root.replaceChildren(summary, body);
  else root.replaceChildren(summary);
}
