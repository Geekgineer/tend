// @ts-check
// The Review tab: the session's files like a PR's "Files changed" page. A tree (changed or all files), a
// viewer (diff unified or side by side, the whole file, rendered Markdown with its changes marked, images),
// "viewed" marks that reset when Claude edits the file again, and line comments sent to Claude as one review.
// Keys while it's showing: j/k file, n/p change, v viewed, ⌘P any file, Ctrl+` back to the terminal.
import { diff, fileText, rawUrl, say, tree } from './api.js';
import { createPalette, score } from './palette.js';
import { renderMarkdown } from './review-md.js';
import { buildTree, compact, extClass, isImage, isMarkdown, parseDiff, reviewMessage } from './review-model.js';
import { button, composer, el, load, renderDiff, renderSource, save, typing } from './review-view.js';

/** @typedef {import('./api.js').SessionView} SessionView */
/** @typedef {import('./api.js').TreeView} TreeView */
/** @typedef {import('./api.js').ChangeView} ChangeView */
/** @typedef {import('./review-model.js').Comment} Comment */
/** @typedef {import('./review-model.js').TreeNode} TreeNode */
/** @typedef {'diff' | 'file' | 'preview' | 'image'} Mode */

const POLL_MS = 4000;
const WIDE = '(min-width: 1400px)';

/**
 * @param {{ host: HTMLElement, work: HTMLElement, term: HTMLElement }} els
 * @param {{ notice: (msg: string) => void, focusTerminal: () => void, onTab?: (tab: 'terminal' | 'review') => void }} hooks
 */
export function createReview({ host, work, term }, hooks) {
  /** @type {SessionView | undefined} */
  let view;
  /** @type {'terminal' | 'review'} */
  let tab = 'terminal';
  /** @type {'changed' | 'all'} */
  let list = 'changed';
  /** @type {TreeView | null} */
  let data = null;
  let dataFor = '';
  /** @type {string | null} */
  let path = null;
  /** @type {Mode | null} */
  let mode = null;
  let full = false;
  let split = load('tend.review.split', true) === true;
  let pinned = load('tend.review.pin', false) === true;
  /** @type {Set<string>} */
  const open = new Set();
  /** @type {Comment[]} */
  let comments = [];
  /** @type {Record<string, string>} */
  let viewed = {};
  let seq = 0;
  let lastKey = '';
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let poll;
  /** a file asked for before any session was shown (the `review=` link) @type {string | undefined} */
  let pending;
  const wide = matchMedia(WIDE);

  // ---- skeleton ------------------------------------------------------------
  const tabs = el('div', 'seg dtabs');
  tabs.setAttribute('role', 'tablist');
  const [tTerm, tRev] = [button('Terminal', '', 'Ctrl+`'), button('Review', '', 'Ctrl+`')];
  const tCount = el('span', 'c');
  tRev.append(tCount);
  tTerm.addEventListener('click', () => setTab('terminal'));
  tRev.addEventListener('click', () => setTab('review'));
  tabs.append(tTerm, tRev);

  const side = el('aside', 'rvside');
  const segL = el('div', 'seg');
  const lChanged = button('Changed', '');
  const lCount = el('span', 'c');
  lChanged.append(lCount);
  const lAll = button('All files', '');
  lChanged.addEventListener('click', () => setList('changed'));
  lAll.addEventListener('click', () => setList('all'));
  segL.append(lChanged, lAll);
  const filterIn = /** @type {HTMLInputElement} */ (el('input', 'rvfilter'));
  filterIn.placeholder = 'Filter files';
  filterIn.name = 'filter';
  filterIn.spellcheck = false;
  filterIn.setAttribute('aria-label', 'Filter files');
  filterIn.addEventListener('input', () => drawTree());
  filterIn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      filterIn.value = '';
      drawTree();
      filterIn.blur();
    }
  });
  const prog = el('div', 'rvprog');
  const treeEl = el('div', 'rvtree');
  treeEl.setAttribute('role', 'tree');
  const top = el('div', 'rvtop');
  top.append(segL, filterIn);
  side.append(top, prog, treeEl);

  const main = el('section', 'rvmain');
  const bar = el('div', 'rvbar');
  const sideBtn = button('Files', 'btn ghost sm rvsidebtn', 'Show the file tree');
  sideBtn.addEventListener('click', () => host.classList.toggle('sideopen'));
  const crumb = el('div', 'rvpath');
  const stat = el('span', 'rvstat');
  const modes = el('div', 'seg rvmodes');
  const style = el('div', 'seg rvstyle');
  const [sUni, sSplit] = [button('Unified', ''), button('Split', '')];
  sUni.addEventListener('click', () => setSplit(false));
  sSplit.addEventListener('click', () => setSplit(true));
  style.append(sUni, sSplit);
  const fullBtn = button('Full file', 'btn ghost sm', 'Show the whole file around the changes');
  fullBtn.addEventListener('click', () => {
    full = !full;
    void show();
  });
  const viewedLbl = el('label', 'rvviewed');
  const viewedIn = /** @type {HTMLInputElement} */ (el('input'));
  viewedIn.type = 'checkbox';
  viewedIn.name = 'viewed';
  viewedIn.addEventListener('change', () => toggleViewed());
  viewedLbl.append(viewedIn, el('span', '', 'Viewed'));
  viewedLbl.title = 'Mark as viewed (v). It resets when Claude edits the file again.';
  const pinBtn = button('Pin terminal', 'btn ghost sm rvpin', 'Keep the live terminal beside the review');
  pinBtn.addEventListener('click', () => setPinned(!pinned));
  const flash = el('span', 'rvflash', 'Updated');
  flash.hidden = true;
  bar.append(sideBtn, crumb, stat, flash, el('span', 'sp'), modes, style, fullBtn, viewedLbl, pinBtn);
  const body = el('div', 'rvbody');
  const content = el('div', 'rvcontent');
  body.append(content);
  const foot = el('div', 'rvfoot');
  foot.hidden = true;
  main.append(bar, body, foot);
  host.append(side, main);

  const palette = createPalette(
    () =>
      (data?.files ?? []).concat((data?.changes ?? []).filter((c) => c.status === 'D').map((c) => c.path)).map((p) => ({
        id: `f:${p}`,
        label: p.slice(p.lastIndexOf('/') + 1),
        hint: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '',
        run: () => openFile(p),
      })),
    { placeholder: 'Go to file…', label: 'Go to file' },
  );

  // ---- state helpers ---------------------------------------------------------
  const changeOf = (/** @type {string} */ p) => data?.changes.find((c) => c.path === p);
  const isViewed = (/** @type {ChangeView} */ c) => viewed[c.path] === c.fp;
  const storeKey = (/** @type {string} */ what) => `tend.review.${what}.${view?.id ?? ''}`;

  function setTab(/** @type {'terminal' | 'review'} */ t) {
    if (t === 'review' && !view) return;
    tab = t;
    layout();
    hooks.onTab?.(t);
    if (t === 'review') {
      void refresh(true);
      if (document.activeElement?.closest('.xterm')) /** @type {HTMLElement} */ (document.activeElement).blur();
    } else hooks.focusTerminal();
  }
  function layout() {
    const rev = tab === 'review';
    tTerm.classList.toggle('on', !rev);
    tRev.classList.toggle('on', rev);
    tTerm.setAttribute('aria-selected', String(!rev));
    tRev.setAttribute('aria-selected', String(rev));
    host.hidden = !rev;
    const pin = rev && pinned && wide.matches;
    work.classList.toggle('pinned', pin);
    // behind the review, not removed: same size, so Claude's window never resizes and xterm keeps measuring
    term.classList.toggle('behind', rev && !pin);
    pinBtn.hidden = !wide.matches;
    pinBtn.classList.toggle('on', pinned);
    pinBtn.textContent = pinned ? 'Unpin' : 'Pin terminal';
    clearInterval(poll);
    if (rev) poll = setInterval(() => view?.state.status === 'working' && void refresh(false), POLL_MS);
  }
  wide.addEventListener('change', layout);
  function setPinned(/** @type {boolean} */ p) {
    pinned = p;
    save('tend.review.pin', p);
    layout();
  }
  function setSplit(/** @type {boolean} */ s) {
    split = s;
    save('tend.review.split', s);
    void show();
  }
  function setList(/** @type {'changed' | 'all'} */ l) {
    list = l;
    drawTree();
  }

  // ---- data ------------------------------------------------------------------
  /** Fetch the tree; reload the open file if Claude changed it since. @param {boolean} first */
  async function refresh(first) {
    if (!view || tab !== 'review') return;
    const id = view.id;
    try {
      const t = await tree(id);
      if (view?.id !== id) return;
      const before = path ? changeOf(path)?.fp : undefined;
      data = t;
      dataFor = id;
      if (first && list === 'changed' && !t.changes.length) list = 'all';
      if (first && path) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join('/'));
        if (list === 'changed' && !changeOf(path)) list = 'all';
      }
      drawTree();
      if (!path || (!t.files.includes(path) && !changeOf(path))) {
        const next = t.changes[0]?.path ?? t.files.find((f) => /^readme\.md$/i.test(f)) ?? t.files.find(isMarkdown) ?? null;
        if (next) openFile(next);
        else drawEmpty();
      } else if (first || changeOf(path)?.fp !== before) {
        await show(true);
        if (!first) {
          flash.hidden = false;
          setTimeout(() => (flash.hidden = true), 1600);
        }
      }
    } catch (x) {
      if (view?.id === id && first) {
        content.replaceChildren(el('p', 'rnote', x instanceof Error ? x.message : 'Could not list the files.'));
      }
    }
  }

  function drawEmpty() {
    path = null;
    crumb.replaceChildren();
    stat.textContent = '';
    modes.replaceChildren();
    style.hidden = fullBtn.hidden = viewedLbl.hidden = true;
    content.replaceChildren(el('p', 'rnote', 'No files here yet.'));
  }

  // ---- tree ------------------------------------------------------------------
  function drawTree() {
    const changes = data?.changes ?? [];
    lChanged.classList.toggle('on', list === 'changed');
    lAll.classList.toggle('on', list === 'all');
    lCount.textContent = changes.length ? String(changes.length) : '';
    const seen = changes.filter(isViewed).length;
    prog.hidden = list !== 'changed' || !changes.length;
    prog.replaceChildren(el('span', 'track'), el('span', '', `${seen} of ${changes.length} viewed`));
    /** @type {HTMLElement} */ (prog.firstChild).style.setProperty('--p', `${changes.length ? (seen / changes.length) * 100 : 0}%`);
    const q = filterIn.value.trim();
    let files = list === 'changed' ? [] : (data?.files ?? []);
    let ch = changes;
    if (q) {
      files = files.filter((p) => score(q, p) >= 0);
      ch = ch.filter((c) => score(q, c.path) >= 0);
    }
    const root = compact(buildTree(files, ch));
    const flat = !!q || list === 'changed';
    const rows = document.createDocumentFragment();
    /** @param {TreeNode} n @param {number} depth */
    const walk = (n, depth) => {
      for (const c of n.children) {
        const row = el('div', `rvrow${c.dir ? ' dir' : ''}${c.path === path ? ' on' : ''}`);
        row.style.setProperty('--d', String(depth));
        row.setAttribute('role', 'treeitem');
        row.tabIndex = -1;
        row.dataset.path = c.path;
        const isOpen = c.dir && (flat || open.has(c.path));
        if (c.dir) {
          row.setAttribute('aria-expanded', String(isOpen));
          row.append(el('span', 'tw', isOpen ? '▾' : '▸'), el('span', 'nm', c.name));
          if (list === 'all' && !flat) row.append(el('span', 'ct', String(c.files)));
          row.addEventListener('click', () => {
            if (flat) return;
            if (open.has(c.path)) open.delete(c.path);
            else open.add(c.path);
            drawTree();
          });
        } else {
          const chg = c.change;
          row.append(el('span', `ic ${extClass(c.name)}`), el('span', `nm${chg?.status === 'D' ? ' gone' : ''}`, c.name));
          if (chg) {
            const meta = el('span', 'meta');
            if (chg.add !== null || chg.del !== null) {
              if (chg.add) meta.append(el('span', 'a', `+${chg.add}`));
              if (chg.del) meta.append(el('span', 'd', `−${chg.del}`));
            }
            meta.append(el('span', `st st${chg.status}`, chg.status));
            if (isViewed(chg)) row.classList.add('seen');
            row.append(meta);
          }
          row.title = c.path;
          row.addEventListener('click', () => {
            openFile(c.path);
            host.classList.remove('sideopen');
          });
        }
        rows.append(row);
        if (isOpen) walk(c, depth + 1);
      }
    };
    walk(root, 0);
    if (!root.children.length) rows.append(el('p', 'rnote', q ? 'No file matches.' : list === 'changed' ? 'Nothing changed yet.' : 'No files.'));
    if (data?.truncated && list === 'all') rows.append(el('p', 'rnote', `Showing the first ${data.files.length.toLocaleString()} files.`));
    treeEl.replaceChildren(rows);
    treeEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  // ---- viewer ----------------------------------------------------------------
  /** @param {string} p */
  function openFile(p) {
    if (!view) return;
    if (p !== path) {
      path = p;
      mode = null;
      full = false;
    }
    if (dataFor !== view.id) {
      // the tree isn't here yet: it opens this file when it arrives
      if (tab !== 'review') setTab('review');
      return;
    }
    if (tab !== 'review') setTab('review');
    // reveal it in the tree
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join('/'));
    if (list === 'changed' && !changeOf(p)) list = 'all';
    drawTree();
    void show();
  }

  /** @param {string} p @returns {Mode[]} */
  function modesFor(p) {
    const c = changeOf(p);
    if (c?.status === 'D') return ['diff'];
    if (isImage(p)) return ['image'];
    if (isMarkdown(p)) return c ? ['preview', 'diff', 'file'] : ['preview', 'file'];
    return c ? ['diff', 'file'] : ['file'];
  }
  const LABEL = { diff: 'Diff', file: 'Source', preview: 'Preview', image: 'Image' };

  /** Draw the open file in the current mode. @param {boolean} [keepScroll] */
  async function show(keepScroll = false) {
    if (!view || !path) return;
    const id = view.id;
    const p = path;
    const my = ++seq;
    const avail = modesFor(p);
    if (!mode || !avail.includes(mode)) mode = avail[0];
    const m = mode;
    const c = changeOf(p);
    // bar
    const dirs = p.split('/');
    const name = /** @type {string} */ (dirs.pop());
    crumb.replaceChildren(...dirs.map((d) => el('span', 'dir', `${d}/`)), el('b', '', name));
    crumb.title = p;
    stat.replaceChildren();
    if (c) {
      if (c.add) stat.append(el('span', 'a', `+${c.add}`));
      if (c.del) stat.append(el('span', 'd', `−${c.del}`));
      if (c.status === 'A') stat.append(el('span', 'tag', 'new'));
      if (c.status === 'D') stat.append(el('span', 'tag del', 'deleted'));
    }
    modes.replaceChildren(
      ...avail.map((x) => {
        const b = button(LABEL[x], x === m ? 'on' : '');
        b.addEventListener('click', () => {
          mode = x;
          void show();
        });
        return b;
      }),
    );
    modes.hidden = avail.length < 2;
    style.hidden = m !== 'diff';
    sUni.classList.toggle('on', !split);
    sSplit.classList.toggle('on', split);
    fullBtn.hidden = m !== 'diff' || c?.status !== 'M';
    fullBtn.classList.toggle('on', full);
    viewedLbl.hidden = !c;
    viewedIn.checked = !!c && isViewed(c);
    const scroll = keepScroll ? body.scrollTop : 0;
    if (!keepScroll) content.replaceChildren(el('p', 'rnote', 'Loading…'));
    content.className = `rvcontent ${m}`;
    const codeOpts = {
      path: p,
      comments,
      onLine: (/** @type {import('./review-view.js').LineRef} */ ref, /** @type {HTMLElement} */ after) =>
        composer(after, ref, {
          onAdd: (text) => {
            comments = [...comments, { path: p, line: ref.line, side: ref.side, code: ref.code, text }];
            save(storeKey('comments'), comments);
            drawFoot();
            void show(true);
          },
          onCancel: () => undefined,
        }),
      onDelete: (/** @type {Comment} */ x) => {
        comments = comments.filter((y) => y !== x);
        save(storeKey('comments'), comments);
        drawFoot();
        void show(true);
      },
    };
    try {
      if (m === 'diff') {
        const d = await diff(id, p, full);
        if (my !== seq || view?.id !== id) return;
        if (d.binary) content.replaceChildren(el('p', 'rnote', 'Binary file: no text diff.'));
        else if (!d.diff.trim()) content.replaceChildren(el('p', 'rnote', 'No changes against the session start.'));
        else {
          renderDiff(content, parseDiff(d.diff), { ...codeOpts, split: split && body.clientWidth >= 900, onExpand: () => ((full = true), void show()) });
          if (d.truncated) content.append(el('p', 'rnote', 'The diff is cut here (too long).'));
        }
      } else if (m === 'image') {
        const img = /** @type {HTMLImageElement} */ (el('img', 'rvimg'));
        img.src = rawUrl(id, p);
        img.alt = p;
        const wrap = el('div', 'rvimgwrap');
        wrap.append(img);
        content.replaceChildren(wrap);
      } else {
        const [f, old] = await Promise.all([fileText(id, p), m === 'preview' && c?.status === 'M' && data?.git ? fileText(id, p, true).catch(() => null) : Promise.resolve(null)]);
        if (my !== seq || view?.id !== id) return;
        if (f.binary) content.replaceChildren(el('p', 'rnote', 'Binary file: nothing to show.'));
        else if (m === 'preview') {
          const doc = el('article', 'md');
          const r = renderMarkdown(doc, f.text, { path: p, rawUrl: (x) => rawUrl(id, x), onOpen: openFile, ...(c?.status === 'M' ? { old: old && !old.missing ? old.text : null } : {}) });
          content.replaceChildren(doc);
          if (c && r.changed) stat.append(el('span', 'tag', `${r.changed} changed block${r.changed === 1 ? '' : 's'} marked`));
        } else renderSource(content, f.text, codeOpts);
        if (f.truncated) content.append(el('p', 'rnote', 'The file is cut here (too large to show whole).'));
      }
    } catch (x) {
      if (my !== seq || view?.id !== id) return;
      content.replaceChildren(el('p', 'rnote', x instanceof Error ? x.message : 'Could not load the file.'));
    }
    body.scrollTop = scroll;
  }

  // ---- viewed, comments ---------------------------------------------------------
  function toggleViewed() {
    const c = path ? changeOf(path) : undefined;
    if (!c) return;
    if (isViewed(c)) delete viewed[c.path];
    else viewed[c.path] = c.fp;
    save(storeKey('viewed'), viewed);
    viewedIn.checked = isViewed(c);
    drawTree();
    if (isViewed(c)) step(1, true); // like GitHub: done with this one, on to the next unviewed
  }

  function drawFoot() {
    foot.hidden = comments.length === 0;
    if (!comments.length || !view) {
      foot.replaceChildren(); // no stale Send button left behind for another session's comments
      return;
    }
    const v = view;
    // while it works, Claude Code queues the message for when the step is done; a dialog would eat the keys
    const ready = (v.state.status === 'idle' || v.state.status === 'working') && !v.paused && !v.decisions?.length;
    const send = button(`Send review to Claude`, 'btn pri sm');
    send.disabled = !ready;
    send.title = !ready
      ? 'Claude is waiting on something else (or paused): send when that is done'
      : v.state.status === 'working' ? 'Claude reads it as soon as it finishes the current step' : 'Types the comments into the session and sends them';
    send.addEventListener('click', async () => {
      if (!comments.length || view?.id !== v.id) return;
      const msg = reviewMessage(comments);
      send.disabled = true;
      try {
        await say(v.id, msg); // the server checks Claude's screen for a dialog first
        const n = comments.length;
        comments = [];
        save(storeKey('comments'), comments);
        drawFoot();
        setTab('terminal');
        hooks.notice(`Review sent to ${v.name} (${n} comment${n === 1 ? '' : 's'}).`);
      } catch (x) {
        send.disabled = false;
        hooks.notice(x instanceof Error ? x.message : 'Could not send the review.');
      }
    });
    const discard = button('Discard', 'btn ghost sm');
    discard.addEventListener('click', () => {
      if (!confirm(`Discard ${comments.length} comment${comments.length === 1 ? '' : 's'}?`)) return;
      comments = [];
      save(storeKey('comments'), comments);
      drawFoot();
      void show(true);
    });
    const files = new Set(comments.map((c) => c.path)).size;
    foot.replaceChildren(el('span', 'n', `${comments.length} comment${comments.length === 1 ? '' : 's'} on ${files} file${files === 1 ? '' : 's'}`), el('span', 'sp'), discard, send);
  }

  // ---- keys ------------------------------------------------------------------
  /** Next/previous file in tree order (changed files first when on "Changed"). @param {1 | -1} d @param {boolean} [unviewed] */
  function step(d, unviewed = false) {
    const order = Array.from(treeEl.querySelectorAll('.rvrow:not(.dir)'), (r) => /** @type {HTMLElement} */ (r).dataset.path ?? '');
    if (!order.length) return;
    const i = path ? order.indexOf(path) : -1;
    for (let k = 1; k <= order.length; k++) {
      const p = order[(i + d * k + order.length * k) % order.length];
      const c = changeOf(p);
      if (unviewed && (!c || isViewed(c))) continue;
      if (unviewed && p === path) return;
      openFile(p);
      return;
    }
  }
  /** Scroll to the next/previous change in the open diff. @param {1 | -1} d */
  function hunk(d) {
    const heads = Array.from(content.querySelectorAll('.rh, .mdnew'));
    if (!heads.length) return;
    const y = body.getBoundingClientRect().top + 8;
    const target = d > 0 ? heads.find((h) => h.getBoundingClientRect().top > y + 4) : heads.reverse().find((h) => h.getBoundingClientRect().top < y - 4);
    (target ?? (d > 0 ? null : heads[heads.length - 1]))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.defaultPrevented) return;
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Backquote' && !/** @type {HTMLElement | null} */ (e.target)?.closest?.('.xterm')) {
      e.preventDefault();
      setTab(tab === 'review' ? 'terminal' : 'review');
      return;
    }
    if (tab !== 'review' || host.hidden || document.querySelector('dialog[open]')) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === 'KeyP') {
      e.preventDefault();
      palette.open();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    const k = e.key;
    if (k === 'j') step(1);
    else if (k === 'k') step(-1);
    else if (k === 'n') hunk(1);
    else if (k === 'p') hunk(-1);
    else if (k === 'v') toggleViewed();
    else if (k === '/') filterIn.focus();
    else return;
    e.preventDefault();
  });

  layout();
  return {
    tabs,
    get tab() {
      return tab;
    },
    setTab,
    toggle: () => setTab(tab === 'review' ? 'terminal' : 'review'),
    /** Open a file in the Review tab (from the terminal's links, the palette). @param {string} [p] */
    open(p) {
      if (!view) pending = p ?? '';
      else if (p) openFile(p);
      else setTab('review');
    },
    /** @param {SessionView | undefined} v */
    update(v) {
      const switched = v?.id !== view?.id;
      view = v;
      tCount.textContent = v?.git?.changed.length ? String(v.git.changed.length) : '';
      tabs.hidden = !v;
      if (switched) {
        seq++; // a file still loading for the previous session must not land here
        data = null;
        dataFor = '';
        path = null;
        mode = null;
        open.clear();
        list = 'changed';
        comments = load(storeKey('comments'), []);
        viewed = load(storeKey('viewed'), {});
        lastKey = '';
        treeEl.replaceChildren();
        content.replaceChildren();
        if (!v && tab === 'review') setTab('terminal');
      }
      drawFoot();
      if (v && pending !== undefined) {
        const p = pending;
        pending = undefined;
        if (p) openFile(p);
        else setTab('review');
        return;
      }
      const key = v ? `${v.id}|${v.state.status}|${v.git?.changed.join('\0') ?? ''}` : '';
      if (key !== lastKey) {
        lastKey = key;
        if (tab === 'review') void refresh(switched || dataFor !== v?.id);
      }
    },
  };
}
