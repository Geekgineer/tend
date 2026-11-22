// @ts-check
// Live terminal: xterm.js mirroring a tmux pane through /term (bytes), /snapshot (screen) and /keys.
import { resize, sendKeys, snapshot, stream, ApiError } from './api.js';
import { findLinks, openable } from './links.js';

/**
 * Keys Tend takes from the terminal: ⌘⇧K / Ctrl⇧K (palette), ⌘Esc / Ctrl+Esc (leave it) and Ctrl+` (Review tab). Never while composing.
 * @param {KeyboardEvent} e @returns {'palette' | 'leave' | 'review' | null}
 */
export function termChord(e) {
  if (e.type !== 'keydown' || e.isComposing || e.keyCode === 229 || e.repeat) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.shiftKey && e.code === 'KeyK') return 'palette';
  if (mod && e.key === 'Escape') return 'leave';
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Backquote') return 'review'; // VS Code's terminal toggle
  return null;
}

export const RESIZE_DEBOUNCE_MS = 150;

/** @param {string} name @param {string} fallback */
function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * @param {HTMLElement} el
 * @param {string} id
 * @param {{ snap?: boolean, onEnded?: () => void, onNotice?: (msg: string) => void,
 *   onPalette?: () => void, onReview?: () => void, changed?: () => string[], onOpenFile?: (path: string) => void }} [opts]
 *   `snap`: draw the snapshot only, open no stream and send no keys (headless screenshots).
 *   `onEnded`: the session's pane is gone (404 or the stream ended).
 *   `onNotice`: something the user should see briefly (e.g. typed input that didn't arrive).
 * @returns {() => void} dispose
 */
export function mountTerminal(el, id, opts = {}) {
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.25,
    cursorBlink: !opts.snap,
    scrollback: 2000,
    theme: {
      background: cssVar('--term', '#0b0c0e'),
      foreground: cssVar('--term-fg', '#d5d8de'),
      cursor: cssVar('--term-fg', '#d5d8de'),
      selectionBackground: 'rgba(160,164,173,.3)',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);

  // Focus rule (spec §6): every key goes to Claude except ⌘⇧K (palette) and ⌘Esc (leave the terminal).
  // Plain Esc twice stays Claude's (rewind / edit the previous message).
  term.attachCustomKeyEventHandler((e) => {
    const k = termChord(e);
    if (!k) return true;
    e.preventDefault();
    if (k === 'palette') opts.onPalette?.();
    else if (k === 'review') opts.onReview?.();
    else term.blur();
    return false;
  });
  // Smart links: URLs and loopback ports open a tab; files the session changed open in the Review tab.
  const open = (/** @type {string} */ uri) => {
    if (openable(uri)) window.open(uri, '_blank', 'noopener');
  };
  // OSC 8 links show one text and open another: say where it goes when that's not what the text shows
  term.options.linkHandler = {
    activate: (_e, uri) => {
      if (!openable(uri)) return;
      if (confirm(`Open ${uri}?`)) open(uri);
    },
    allowNonHttpProtocols: false,
  };
  term.registerLinkProvider({
    provideLinks(y, done) {
      const row = term.buffer.active.getLine(y - 1);
      const line = row?.translateToString(true) ?? '';
      const links = findLinks(line, opts.changed?.() ?? []);
      // string offsets → cell columns (wide characters take two cells)
      const col = /** @type {number[]} */ ([]);
      if (row) for (let x = 0; x < row.length; x++) {
        const c = row.getCell(x);
        if (!c || c.getWidth() === 0) continue;
        for (let i = 0; i < c.getChars().length || i === 0; i++) col.push(x);
      }
      const at = (/** @type {number} */ i) => (col[i] ?? i) + 1;
      done(
        links.map((l) => ({
          range: { start: { x: at(l.start), y }, end: { x: at(l.end - 1), y } },
          text: line.slice(l.start, l.end),
          activate: () => (l.kind === 'url' ? open(l.target) : opts.onOpenFile?.(l.target)),
        })),
      );
    },
  });

  let disposed = false;
  let ended = false;
  let closeStream = () => {};
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let sent = '';

  // While a snapshot is in flight, stream bytes wait here and are written after it.
  let buffering = true;
  /** @type {Uint8Array[]} */
  let pending = [];
  let generation = 0;

  /** @param {Uint8Array} bytes */
  const onBytes = (bytes) => {
    if (buffering) pending.push(bytes);
    else term.write(bytes);
  };

  const end = () => {
    if (ended || disposed) return;
    ended = true;
    closeStream();
    term.options.disableStdin = true;
    term.options.cursorBlink = false;
    opts.onEnded?.();
  };

  /** Replace the screen with a fresh snapshot, then flush what streamed in meanwhile. */
  async function resync() {
    const mine = ++generation;
    buffering = true;
    let snap;
    try {
      snap = await snapshot(id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) end();
    }
    if (disposed || mine !== generation) return; // a newer resync owns the buffer now
    if (snap) {
      term.reset();
      term.write(snap);
    }
    const queued = pending;
    pending = [];
    buffering = false;
    for (const b of queued) term.write(b);
  }

  /** Fit to the element; tell tmux when the grid changed. @returns {Promise<boolean>} changed */
  async function pushSize() {
    // hidden (the Review tab is showing): measuring now would shrink Claude's window to nothing
    if (!el.offsetWidth || !el.offsetHeight) return false;
    fit.fit();
    const size = `${term.cols}x${term.rows}`;
    if (size === sent || ended) return false;
    sent = size;
    try {
      await resize(id, term.cols, term.rows);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) end();
    }
    return true;
  }

  const ro = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (disposed) return;
      if (await pushSize()) await resync(); // tmux re-wraps on resize; redraw from its screen
    }, RESIZE_DEBOUNCE_MS);
  });

  const dataSub = term.onData((d) => {
    if (opts.snap || ended) return;
    sendKeys(id, d).catch((e) => {
      if (e instanceof ApiError && e.status === 404) end();
      else {
        const why = e instanceof ApiError ? e.message : 'tend is not reachable';
        opts.onNotice?.(`Some input didn't reach the session (${why}).`);
      }
    });
  });

  // Measure with the real font, or the grid misaligns when it arrives.
  document.fonts.ready.then(async () => {
    if (disposed) return;
    if (opts.snap) {
      await pushSize();
      await resync();
    } else {
      // Stream first, buffered; snapshot once the stream is attached, then flush (no gap, no lost bytes).
      closeStream = stream(id, onBytes, {
        onOpen: async () => {
          if (disposed) return;
          await pushSize();
          await resync();
          if (!disposed) term.focus(); // the closing dialog may have taken focus back meanwhile
        },
        onEnd: end,
      });
    }
    ro.observe(el);
    if (!opts.snap) term.focus();
  });

  return () => {
    disposed = true;
    clearTimeout(timer);
    ro.disconnect();
    closeStream();
    dataSub.dispose();
    // after xterm's own next-frame repaint (term.reset() schedules one): disposing first makes it throw
    requestAnimationFrame(() => term.dispose());
  };
}
