// @ts-check
// Markdown for the Review tab: GitHub-flavoured, code highlighted, sanitised (files are written by an AI and
// may carry HTML). Relative links open inside the Review tab; relative images come from the session folder;
// remote images are not loaded (tend never phones home).
import { Marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import hljs from '/vendor/highlight.js';
import { changedBlocks, isImage, langOf } from './review-model.js';

/** @param {string} s */
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** @param {string} s */
export const slugOf = (s) => s.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

/** Highlighted HTML for code (escaped plain text when the language is unknown). @param {string} code @param {string} lang */
export function highlight(code, lang) {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to plain
    }
  }
  return esc(code);
}

const md = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const l = (lang ?? '').split(/\s/)[0] ?? '';
      const name = hljs.getLanguage(l) ? l : langOf(`x.${l}`);
      return `<pre class="mdcode"><code class="hljs">${highlight(text, name)}</code></pre>`;
    },
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="md-${esc(slugOf(inner))}">${inner}</h${depth}>`;
    },
  },
});

/** "a/b/c.md" + "../d.png" → "a/d.png"; null if it climbs out of the folder. @param {string} from @param {string} href */
export function resolveRel(from, href) {
  const clean = href.split('#')[0].split('?')[0];
  if (!clean) return null;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // keep as written
  }
  const parts = decoded.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const p of decoded.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts.length ? parts.join('/') : null;
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Render Markdown into `host`. `old` (the text at the session start) marks new or changed blocks.
 * @param {HTMLElement} host
 * @param {string} text
 * @param {{ path: string, rawUrl: (path: string) => string, onOpen: (path: string) => void, old?: string | null }} o
 */
export function renderMarkdown(host, text, o) {
  const tokens = md.lexer(text);
  const blocks = tokens.filter((t) => t.type !== 'space');
  /** @type {boolean[]} */
  let flags = blocks.map(() => false);
  if (o.old !== undefined) {
    const before = o.old === null ? [] : md.lexer(o.old).filter((t) => t.type !== 'space').map((t) => t.raw);
    flags = changedBlocks(before, blocks.map((t) => t.raw));
  }
  const html = blocks
    .map((t, i) => {
      const one = /** @type {any} */ ([t]);
      one.links = tokens.links;
      return `<div class="mdb${flags[i] ? ' mdnew' : ''}">${md.parser(one)}</div>`;
    })
    .join('');

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = /** @type {Element} */ (node);
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        el.setAttribute('data-anchor', `md-${slugOf(decodeURIComponent(href.slice(1)))}`);
      } else if (EXTERNAL.test(href) || href.startsWith('//')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      } else {
        const p = resolveRel(o.path, href);
        if (p) el.setAttribute('data-path', p);
        el.removeAttribute('href');
        el.setAttribute('role', 'link');
        el.setAttribute('tabindex', '0');
      }
    } else if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      const p = EXTERNAL.test(src) || src.startsWith('//') ? null : resolveRel(o.path, src);
      if (p && !isImage(p)) el.setAttribute('data-bad', '1');
      if (p && isImage(p)) el.setAttribute('src', o.rawUrl(p));
      else {
        el.removeAttribute('src');
        el.removeAttribute('srcset');
        el.setAttribute('data-blocked', src.slice(0, 200));
      }
    } else if (el.tagName === 'INPUT') {
      if (el.getAttribute('type') !== 'checkbox') el.remove();
      else el.setAttribute('disabled', '');
    }
  });
  let clean;
  try {
    clean = DOMPurify.sanitize(html, {
      FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'link', 'meta', 'base'],
      FORBID_ATTR: ['style', 'srcset'],
      RETURN_DOM_FRAGMENT: true,
    });
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
  for (const img of Array.from(clean.querySelectorAll('img[data-blocked]'))) {
    const note = document.createElement('span');
    note.className = 'mdblocked';
    const what = img.getAttribute('data-blocked') || img.getAttribute('alt') || 'image';
    note.textContent = img.hasAttribute('data-bad') ? `Not an image: ${what}` : `Remote image not loaded: ${what}`;
    img.replaceWith(note);
  }
  host.replaceChildren(clean);
  host.onclick = (e) => {
    const a = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('a'));
    if (!a) return;
    if (a.dataset.anchor) {
      e.preventDefault();
      host.querySelector(`#${CSS.escape(a.dataset.anchor)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (a.dataset.path) {
      e.preventDefault();
      o.onOpen(a.dataset.path);
    }
  };
  host.onkeydown = (e) => {
    if (e.key === 'Enter') /** @type {HTMLElement} */ (e.target).closest('a')?.click();
  };
  return { changed: flags.filter(Boolean).length };
}
