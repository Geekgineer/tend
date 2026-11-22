// @ts-check
// The Review tab's pure parts (no DOM): unified diffs into hunks and side-by-side rows, the file tree,
// languages by extension, Markdown block changes, and the review message sent to Claude.

/** @typedef {{ kind: ' ' | '+' | '-', text: string, old: number | null, new: number | null }} DiffLine */
/** @typedef {{ header: string, oldStart: number, newStart: number, lines: DiffLine[] }} Hunk */
/** @typedef {{ left: DiffLine | null, right: DiffLine | null }} Row */
/** @typedef {{ path: string, status: 'A' | 'M' | 'D', add: number | null, del: number | null, fp: string }} Change */
/** @typedef {{ name: string, path: string, dir: boolean, children: TreeNode[], change?: Change, files: number }} TreeNode */
/** @typedef {{ path: string, line: number, side: 'old' | 'new', code: string, text: string }} Comment */

/** @param {string} text unified diff from git @returns {Hunk[]} */
export function parseDiff(text) {
  /** @type {Hunk[]} */
  const hunks = [];
  /** @type {Hunk | null} */
  let h = null;
  let o = 0;
  let n = 0;
  for (const line of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      h = { header: line, oldStart: o, newStart: n, lines: [] };
      hunks.push(h);
      continue;
    }
    if (!h) {
      // an untracked file comes as "new file <path>" then "+line"s, with no hunk header
      if (line.startsWith('+') && !line.startsWith('+++')) {
        h = { header: '', oldStart: 0, newStart: 1, lines: [] };
        hunks.push(h);
        n = 1;
      } else continue;
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const k = line[0];
    if (k === '+') h.lines.push({ kind: '+', text: line.slice(1), old: null, new: n++ });
    else if (k === '-') h.lines.push({ kind: '-', text: line.slice(1), old: o++, new: null });
    else if (k === ' ') h.lines.push({ kind: ' ', text: line.slice(1), old: o++, new: n++ });
    // '' is only the newline git ends with
  }
  // an untracked file's last line ends with a newline too: no empty added line for it
  const only = hunks.length === 1 && hunks[0].header === '' ? hunks[0] : null;
  if (only?.lines.length && only.lines[only.lines.length - 1].text === '') only.lines.pop();
  return hunks;
}

/** Pair a hunk's lines for side by side: runs of removals face runs of additions. @param {Hunk} h @returns {Row[]} */
export function splitRows(h) {
  /** @type {Row[]} */
  const rows = [];
  let i = 0;
  const L = h.lines;
  while (i < L.length) {
    const l = L[i];
    if (l.kind === ' ') {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const del = [];
    const add = [];
    while (i < L.length && L[i].kind === '-') del.push(L[i++]);
    while (i < L.length && L[i].kind === '+') add.push(L[i++]);
    for (let k = 0; k < Math.max(del.length, add.length); k++) rows.push({ left: del[k] ?? null, right: add[k] ?? null });
  }
  return rows;
}

/**
 * Nested folders from flat paths; changed files carry their change, folders count what's inside.
 * Deleted files are in `changes` but not on disk: they're added so they can still be reviewed.
 * @param {string[]} files @param {Change[]} changes @returns {TreeNode}
 */
export function buildTree(files, changes) {
  /** @type {TreeNode} */
  const root = { name: '', path: '', dir: true, children: [], files: 0 };
  const byPath = new Map(changes.map((c) => [c.path, c]));
  const all = new Set(files);
  for (const c of changes) all.add(c.path);
  /** @type {Map<string, TreeNode>} */
  const dirs = new Map([['', root]]);
  for (const p of [...all].sort()) {
    const parts = p.split('/');
    let parent = root;
    for (let d = 0; d < parts.length - 1; d++) {
      const dp = parts.slice(0, d + 1).join('/');
      let node = dirs.get(dp);
      if (!node) {
        node = { name: parts[d], path: dp, dir: true, children: [], files: 0 };
        dirs.set(dp, node);
        parent.children.push(node);
      }
      parent = node;
    }
    const change = byPath.get(p);
    parent.children.push({ name: parts[parts.length - 1], path: p, dir: false, children: [], files: 1, ...(change ? { change } : {}) });
  }
  /** @param {TreeNode} n @returns {number} */
  const count = (n) => {
    if (!n.dir) return 1;
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.files = n.children.reduce((s, c) => s + count(c), 0);
    return n.files;
  };
  count(root);
  return root;
}

/** Folders whose only child is a folder fold into one row ("src/soak"), like VS Code. @param {TreeNode} n @returns {TreeNode} */
export function compact(n) {
  if (!n.dir) return n;
  let cur = n;
  while (cur.path !== '' && cur.children.length === 1 && cur.children[0].dir) {
    const only = cur.children[0];
    cur = { ...only, name: `${cur.name}/${only.name}` };
  }
  return { ...cur, children: cur.children.map(compact) };
}

const LANGS = /** @type {Record<string, string>} */ ({
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'bash', zsh: 'bash', bash: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', md: 'markdown', sql: 'sql', lua: 'lua',
  r: 'r', dart: 'dart', scala: 'scala', pl: 'perl', diff: 'diff', graphql: 'graphql', makefile: 'makefile', dockerfile: 'dockerfile',
});
/** The highlight.js language for a path, or '' for plain text. @param {string} path */
export function langOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'makefile' || base === 'dockerfile') return LANGS[base];
  const dot = base.lastIndexOf('.');
  return dot > 0 ? (LANGS[base.slice(dot + 1)] ?? '') : '';
}
/** A colour class for a file's type dot in the tree. @param {string} name */
export function extClass(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (isMarkdown(name)) return 'md';
  if (isImage(name)) return 'img';
  if (/^(ts|tsx|mts|cts)$/.test(ext)) return 'ts';
  if (/^(js|jsx|mjs|cjs)$/.test(ext)) return 'js';
  if (/^(py|rb|go|rs|java|kt|swift|c|cc|cpp|h|cs|php)$/.test(ext)) return 'code';
  if (/^(json|ya?ml|toml|ini|lock)$/.test(ext)) return 'cfg';
  if (/^(css|scss|less|html|svg)$/.test(ext)) return 'web';
  return '';
}
export const isMarkdown = (/** @type {string} */ path) => /\.(md|markdown|mdx)$/i.test(path);
export const isImage = (/** @type {string} */ path) => /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(path);

/**
 * Which top-level Markdown blocks are new or changed since the old text (a longest-common-subsequence
 * over blocks, compared as trimmed source). Returns one flag per new block.
 * @param {string[]} oldBlocks @param {string[]} newBlocks @returns {boolean[]}
 */
export function changedBlocks(oldBlocks, newBlocks) {
  const a = oldBlocks.map((b) => b.trim());
  const b = newBlocks.map((x) => x.trim());
  const m = a.length;
  const n = b.length;
  if (m * n > 4_000_000) return b.map((x) => !a.includes(x)); // huge files: a cheap approximation
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = b.map(() => true);
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out[j] = false;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** The message that carries a review to Claude: one line per comment, grouped by file. @param {Comment[]} comments */
export function reviewMessage(comments) {
  const clean = (/** @type {string} */ t) => t.replace(/[\x00-\x1f\x7f]+/g, ' '); // it travels as one pasted message
  const byFile = new Map();
  for (const c of comments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  const parts = ['Review comments on your changes. Please address each one:'];
  for (const [path, list] of byFile) {
    for (const c of [...list].sort((x, y) => x.line - y.line)) {
      const where = c.side === 'old' ? `${path} (removed line ${c.line})` : `${path}:${c.line}`;
      const code = clean(c.code).trim();
      parts.push(`- ${where}${code ? ` \`${code.length > 80 ? `${code.slice(0, 77)}...` : code}\`` : ''}: ${clean(c.text.trim().replace(/\s*\n\s*/g, ' '))}`);
    }
  }
  return parts.join('\n');
}

/** A short stable hash (FNV-1a) for "viewed" marks. @param {string} s */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * The changed middle of two similar lines (common prefix and suffix trimmed), as [start, end) per side;
 * null when the lines differ almost everywhere (marking it all would be noise).
 * @param {string} a @param {string} b @returns {{ a: [number, number], b: [number, number] } | null}
 */
export function inlineRange(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const indent = Math.min(p, /^\s*/.exec(a)?.[0].length ?? 0); // shared indentation says nothing
  if (p + s - indent < Math.max(a.length, b.length) * 0.3) return null;
  return { a: [p, a.length - s], b: [p, b.length - s] };
}

/**
 * Split highlight.js HTML into lines, closing and reopening spans at each newline so every line is
 * well-formed on its own (multi-line strings and comments keep their colour).
 * @param {string} html @returns {string[]}
 */
export function splitHighlighted(html) {
  const lines = [];
  /** @type {string[]} */
  const open = [];
  let cur = '';
  for (const t of html.match(/<span[^>]*>|<\/span>|\n|[^<\n]+|</g) ?? []) {
    if (t === '\n') {
      lines.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    } else if (t.startsWith('<span')) {
      open.push(t);
      cur += t;
    } else if (t === '</span>') {
      open.pop();
      cur += t;
    } else cur += t;
  }
  lines.push(cur + '</span>'.repeat(open.length));
  return lines;
}
