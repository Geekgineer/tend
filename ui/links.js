// @ts-check
// Smart links in the terminal (spec §6): URLs, loopback dev servers, and files the session changed. Links only
// open things (a tab, the Files panel); they never run anything.

/** @typedef {{ start: number, end: number, kind: 'url' | 'file', target: string }} Link */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g;
const PORT_RE = /\b(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})(\/[^\s<>"'`)\]}]*)?/g;
const PATH_RE = /(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+|[\w@-]+\.\w{1,8}\b/g;

/** Trim trailing punctuation that ends a sentence, not the link. @param {string} s */
const tidy = (s) => s.replace(/[.,;:!?]+$/, '');

/**
 * Links in one terminal line. `changed` are the session's changed paths (repo-relative).
 * @param {string} line @param {string[]} [changed]
 * @returns {Link[]}
 */
export function findLinks(line, changed = []) {
  /** @type {Link[]} */
  const out = [];
  const taken = (/** @type {number} */ a, /** @type {number} */ b) => out.some((l) => a < l.end && b > l.start);
  for (const m of line.matchAll(URL_RE)) {
    const t = tidy(m[0]);
    out.push({ start: m.index, end: m.index + t.length, kind: 'url', target: t });
  }
  for (const m of line.matchAll(PORT_RE)) {
    const t = tidy(m[0]);
    if (taken(m.index, m.index + t.length)) continue;
    out.push({ start: m.index, end: m.index + t.length, kind: 'url', target: `http://${t}` });
  }
  if (changed.length) {
    const set = new Set(changed);
    for (const m of line.matchAll(PATH_RE)) {
      const t = tidy(m[0]);
      const rel = t.replace(/^\.\//, '');
      const hit = set.has(rel) ? rel : changed.find((c) => c.endsWith(`/${rel}`) && rel.includes('/'));
      if (!hit || taken(m.index, m.index + t.length)) continue;
      out.push({ start: m.index, end: m.index + t.length, kind: 'file', target: hit });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Only web links open: http(s), never javascript:, file: or others (OSC 8 links included). @param {string} uri */
export const openable = (uri) => /^https?:\/\//i.test(uri);
