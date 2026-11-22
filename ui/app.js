// @ts-check
// Wires the strip, list, header and terminal together.
// Query params: `snap` (no SSE streams, for headless screenshots), `s=<id>` (select), `tab=you|all`,
// `theme=light|dark`, `new[=<folder>]` (open the New session dialog, folder prefilled), `usage` / `today` / `pace` / `palette` (open those panels),
// `review[=<path>]` (the Review tab, at a file).
import { attention, briefing, cancelChooseFolder, chooseFolder, createSession, events, getSettings, listSessions, park, repoInfo, saveSettings, showNow, usage, wrapup } from './api.js';
import { createCalm, wipNote } from './calm.js';
import { createMedia } from './media.js';
import { createPalette } from './palette.js';
import { createReview } from './review.js';
import { createCompatBanner } from './compat.js';
import { createUsage, left } from './usage.js';
import { renderBriefing } from './briefing.js';
import { renderHeader, wireActions } from './header.js';
import { createDecisionCard } from './decision.js';
import { folderName, forYou, recentFolders, renderList, renderStrip, renderSummary, stateDetail } from './list.js';
import { mountTerminal } from './terminal.js';
import { createElsewhere } from './external.js';

/** @typedef {import('./api.js').SessionView} SessionView */

/** @param {string} id @returns {HTMLElement} */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

const params = new URLSearchParams(location.search);
const SNAP = params.has('snap');
const theme = params.get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
if (params.has('key')) {
  // the cookie is set; keep the token out of history and screen shares
  params.delete('key');
  const q = params.toString();
  history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
}

/** @type {Map<string, SessionView>} */
const views = new Map();
/** Sessions whose terminal stream ended before the server said so. */
const endedHere = new Set();
/** @type {string | null} */
let selected = params.get('s');
/** @type {'you' | 'all' | null} */
let mode = params.get('tab') === 'all' ? 'all' : params.get('tab') === 'you' ? 'you' : null;
/** @type {{ id: string, dispose: () => void } | null} */
let mounted = null;
let loaded = false;

/** @returns {SessionView[]} */
function all() {
  return [...views.values()].map((v) =>
    endedHere.has(v.id) && v.state.status !== 'ended' ? { ...v, state: { status: 'ended', since: v.state.since } } : v,
  );
}

/** First load: open on "For you" if anything is waiting, otherwise on everything. */
function pickDefaults() {
  const list = all();
  if (mode === null) mode = forYou(list).length ? 'you' : 'all';
  if (selected === null || !views.has(selected)) {
    const order = mode === 'you' && forYou(list).length ? forYou(list) : [...list].sort((a, b) => b.createdAt - a.createdAt);
    selected = order[0]?.id ?? null;
  }
}

/** Header requests in flight, as `<id>:<action>`. @type {Set<string>} */
const busy = new Set();
const current = () => all().find((x) => x.id === selected);
const nameOf = (/** @type {string} */ id) => views.get(id)?.name ?? 'another session';

const meter = createUsage($('usage'), { onSelect: (id) => select(id) });
async function loadUsage() {
  try {
    meter.update(await usage());
    if (params.has('usage') && !document.querySelector('.upop')) meter.show();
  } catch {
    // usage is best effort; the pills just stay as they were
  }
}

const calm = createCalm($('calm'), {
  showNow,
  getSettings,
  saveSettings,
  wrapup,
  park,
  onNotice: (msg) => notice(msg),
});

const focusTerm = () => /** @type {HTMLElement | null} */ (document.querySelector('#termHost .xterm-helper-textarea'))?.focus();
const card = createDecisionCard($('decision'), {
  onError: (msg) => notice(msg),
  focusTerminal: focusTerm,
});

const review = createReview({ host: $('review'), work: $('work'), term: $('term') }, { notice: (msg) => notice(msg), focusTerminal: focusTerm });

const media = createMedia(
  { bar: $('mbar'), term: $('term'), list: $('list'), tabs: review.tabs },
  {
    current,
    notice: (msg) => notice(msg),
    focusTerminal: focusTerm,
  },
);

function header() {
  renderHeader($('dh'), current(), nameOf, (id, a) => busy.has(`${id}:${a}`));
  card.update(current() ?? null);
  media.update(current());
  review.update(current());
}

// ---- briefing -------------------------------------------------------------

const brief = $('brief');
const BRIEF_KEY = 'tend.briefOpen';
try {
  brief.toggleAttribute('open', localStorage.getItem(BRIEF_KEY) !== '0');
} catch {
  brief.setAttribute('open', '');
}
brief.addEventListener('toggle', () => {
  try {
    localStorage.setItem(BRIEF_KEY, /** @type {HTMLDetailsElement} */ (brief).open ? '1' : '0');
  } catch {
    // storage blocked: the panel just won't remember
  }
});

/** @type {string | null} */
let briefFor = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let briefTimer;

/** Fetch and show the selected session's briefing; late answers for another session are dropped. */
async function loadBriefing() {
  clearTimeout(briefTimer);
  const id = selected;
  if (id !== briefFor) {
    brief.dataset.all = '';
    renderBriefing(brief, null);
    briefFor = id;
  }
  if (!id || !views.has(id)) return; // archived meanwhile: nothing to fetch
  try {
    const b = await briefing(id);
    if (selected === id) renderBriefing(brief, b);
  } catch {
    if (selected === id) renderBriefing(brief, null);
  }
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let noteTimer;

/** A brief status line over the terminal; it fades on its own. @param {string} [msg] */
function notice(msg) {
  const n = $('termNote');
  clearTimeout(noteTimer);
  n.textContent = msg ?? '';
  n.hidden = !msg;
  if (msg) noteTimer = setTimeout(() => notice(), 6000);
}

function mount() {
  if (mounted?.id === selected) return;
  mounted?.dispose();
  mounted = null;
  notice();
  const host = $('termHost');
  host.replaceChildren();
  if (!selected) return;
  const id = selected;
  mounted = {
    id,
    dispose: mountTerminal(host, id, {
      snap: SNAP,
      onNotice: notice,
      onPalette: () => palette.open(),
      onReview: () => review.toggle(),
      changed: () => views.get(id)?.git?.changed ?? [],
      onOpenFile: (p) => review.open(p),
      onEnded: () => {
        endedHere.add(id);
        render();
      },
    }),
  };
}

// ---- elsewhere (Claude sessions outside tend) -------------------------------

const elsewhere = createElsewhere({
  active: () => mode === 'all',
  onChange: () => render(),
  onAdopted: ({ warning, ...v }) => {
    views.set(v.id, v);
    loaded = true;
    select(v.id);
    if (warning) notice(warning);
  },
  onError: (msg) => notice(msg),
});
void elsewhere.load();

function render() {
  const list = all();
  const empty = loaded && list.length === 0;
  $('main').hidden = empty;
  $('blank').hidden = !empty;
  renderSummary($('summary'), list);
  renderStrip($('strip'), list, selected, select);
  renderList($('list'), list, mode ?? 'all', selected, select);
  elsewhere.render($('list'));
  const you = forYou(list).length;
  $('cYou').textContent = you ? String(you) : '';
  $('cAll').textContent = String(list.length);
  document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.v === mode));
  header();
  const cur = current();
  const paused = $('termPaused');
  paused.hidden = !cur?.paused;
  if (cur?.paused && cur.workspace.mode === 'worktree') {
    paused.textContent = `Paused. Work in progress is committed on ${cur.workspace.branch}. Resume picks up the same conversation.`;
  }
  document.title = you ? `(${you}) tend.` : 'tend.';
}

/** @param {string} id */
function select(id) {
  const changed = id !== selected;
  selected = id;
  render();
  mount();
  if (changed || briefFor !== id) loadBriefing();
}

/** Drop an archived session; if it was selected, move to the row after it (or before). @param {string} id */
function drop(id) {
  if (!views.has(id)) return;
  if (selected === id) {
    const order = Array.from($('list').querySelectorAll('[data-id]'), (b) => /** @type {HTMLElement} */ (b).dataset.id);
    const i = order.indexOf(id);
    const next = order.slice(i + 1).concat(order.slice(0, Math.max(i, 0)).reverse()).find((x) => x && x !== id && views.has(x));
    views.delete(id);
    endedHere.delete(id);
    selected = next ?? [...views.keys()][0] ?? null;
    render();
    mount();
    loadBriefing();
    return;
  }
  views.delete(id);
  endedHere.delete(id);
  render();
}

/** Re-attach the terminal (e.g. after Resume brought an ended session back). @param {string} id */
function remount(id) {
  if (mounted?.id !== id) return;
  mounted.dispose();
  mounted = null;
  mount();
}

/** @param {SessionView[]} list */
function onSnapshot(list) {
  views.clear();
  for (const v of list) {
    views.set(v.id, v);
    // the server says it's alive (e.g. after a tend restart dropped our stream): re-attach once
    if (v.state.status !== 'ended' && endedHere.delete(v.id) && mounted?.id === v.id) {
      mounted.dispose();
      mounted = null;
    }
  }
  loaded = true;
  pickDefaults();
  render();
  mount();
  loadBriefing();
}

/** @param {SessionView} v */
function onSession(v) {
  if (v.archived) {
    drop(v.id);
    return;
  }
  views.set(v.id, v);
  // back from ended (resumed): the old stream is gone, attach a fresh one
  if (v.state.status !== 'ended' && endedHere.delete(v.id)) remount(v.id);
  const first = selected === null;
  if (first) selected = v.id;
  render();
  mount();
  if (first) loadBriefing();
  else if (v.id === selected) {
    clearTimeout(briefTimer);
    briefTimer = setTimeout(loadBriefing, 500);
  }
}

wireActions($('dh'), {
  current,
  busy,
  notice,
  applied: (v, a) => {
    const { warning: _w, ...view } = v;
    views.set(view.id, view);
    if (a === 'resume') {
      endedHere.delete(view.id);
      remount(view.id);
    }
    render();
    loadBriefing();
  },
  archived: drop,
  rerender: header,
});

// ---- tabs -----------------------------------------------------------------

document.querySelectorAll('#seg button').forEach((b) =>
  b.addEventListener('click', () => {
    mode = /** @type {HTMLElement} */ (b).dataset.v === 'you' ? 'you' : 'all';
    render();
    void elsewhere.load();
  }),
);

// ---- new-session dialog ---------------------------------------------------

const dlg = /** @type {HTMLDialogElement} */ ($('newDlg'));
const form = /** @type {HTMLFormElement} */ ($('newForm'));
const cwdIn = /** @type {HTMLInputElement} */ ($('newCwd'));
const nameIn = /** @type {HTMLInputElement} */ ($('newName'));
const err = $('newErr');
const submit = /** @type {HTMLButtonElement} */ ($('newGo'));
const isoIn = /** @type {HTMLInputElement} */ ($('newIso'));
const hint = $('newHint');
const acctRow = $('newAcctRow');
const acctIn = /** @type {HTMLSelectElement} */ ($('newAcct'));

/** The account choice, only when there are two or more config folders. */
function renderAccounts() {
  const list = meter.accounts;
  acctRow.hidden = list.length < 2;
  const now = Date.now();
  const opts = [new Option('Same as last time in this folder', ''), new Option('Most room right now', 'roomiest')];
  for (const a of list) {
    const w = a.fiveHour;
    opts.push(new Option(w ? `${a.name} · 5h ${Math.round(w.pct)}% · resets in ${left(w.resetsAt - now)}` : `${a.name} · no data yet`, a.dir));
  }
  acctIn.replaceChildren(...opts);
}
const recent = $('newRecent');
const choose = /** @type {HTMLButtonElement} */ ($('newChoose'));

/** The branch slug rule (same as the server's). @param {string} name */
function slug(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'session';
}

/** What GET /api/repo said about the folder in the input; null until it answers. */
let repoKind = /** @type {{ git: boolean, commits: boolean } | null} */ (null);
let repoAsk = 0;
/** The macOS folder window is open (its hint wins over the folder hint). */
let choosing = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let repoTimer;

function updateHint() {
  if (choosing) return;
  if (!repoKind?.git || !repoKind.commits) {
    hint.textContent = 'Not a git repo with commits: the session runs in the folder itself.';
    hint.classList.remove('off');
    return;
  }
  const name = nameIn.value.trim() || folderName(cwdIn.value.trim());
  hint.textContent = `Creates branch tend/${slug(name)}-xxxx from HEAD. Untick to run in the folder itself.`;
  hint.classList.toggle('off', !isoIn.checked);
}

/** Ask the server about the folder, 300 ms after the last keystroke; a stale answer is dropped. */
function checkFolder() {
  clearTimeout(repoTimer);
  const ask = ++repoAsk;
  const path = cwdIn.value.trim();
  if (path === '') {
    repoKind = null;
    updateHint();
    return;
  }
  repoTimer = setTimeout(() => {
    repoInfo(path).then(
      (r) => {
        if (ask !== repoAsk) return;
        repoKind = r;
        updateHint();
      },
      () => undefined,
    );
  }, 300);
}

cwdIn.addEventListener('input', () => {
  updateHint();
  checkFolder();
});

/** @param {string} path */
function setFolder(path) {
  cwdIn.value = path;
  updateHint();
  checkFolder();
}

// the macOS folder window. While it's open the button cancels it (it can open out of sight, e.g. behind a
// full-screen browser), and typing a path still works.
choose.addEventListener('click', async () => {
  if (choosing) {
    void cancelChooseFolder();
    return;
  }
  err.textContent = '';
  choosing = true;
  choose.replaceChildren(Object.assign(document.createElement('span'), { className: 'spin' }), 'Cancel');
  choose.title = 'The folder window is open. Not seeing it? Cancel, or type the path.';
  hint.textContent = 'The folder window is open (it may be behind this window). Not seeing it? Press Cancel or type the path.';
  hint.classList.remove('off');
  try {
    const typed = cwdIn.value.trim();
    const picked = await chooseFolder(typed);
    if (picked && cwdIn.value.trim() === typed) setFolder(picked); // don't overwrite a path typed meanwhile
  } catch (x) {
    err.textContent = x instanceof Error ? x.message : 'Could not open the folder window.';
  } finally {
    choosing = false;
    choose.textContent = 'Choose…';
    choose.title = '';
    updateHint();
    cwdIn.focus();
  }
});
// closing the dialog closes a forgotten folder window too
dlg.addEventListener('close', () => {
  if (choosing) void cancelChooseFolder();
});

function renderRecent() {
  const folders = recentFolders([...views.values()]);
  recent.hidden = folders.length === 0;
  recent.replaceChildren(
    ...folders.map((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = folderName(f);
      b.title = f;
      b.addEventListener('click', () => setFolder(f));
      return b;
    }),
  );
}
nameIn.addEventListener('input', updateHint);
isoIn.addEventListener('change', updateHint);

function openNew() {
  err.textContent = '';
  form.reset();
  checkFolder();
  updateHint();
  renderRecent();
  renderAccounts();
  const active = [...views.values()].filter((v) => v.state.status !== 'ended' && !v.paused).length;
  const note = wipNote(active, calm.settings?.wipLimit ?? Infinity);
  $('newWip').textContent = note ?? '';
  $('newWip').hidden = !note;
  dlg.showModal();
  cwdIn.focus();
}
document.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', openNew));
$('newCancel').addEventListener('click', () => dlg.close());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  submit.disabled = true;
  try {
    const { warning, ...v } = await createSession(cwdIn.value.trim(), nameIn.value, isoIn.checked, acctIn.value || undefined);
    views.set(v.id, v);
    loaded = true;
    dlg.close();
    if (mode === 'you') mode = 'all';
    select(v.id);
    if (warning) notice(warning);
  } catch (x) {
    err.textContent = x instanceof Error ? x.message : 'Could not start the session.';
  } finally {
    submit.disabled = false;
  }
});

// ---- palette (⌘K outside the terminal, ⌘⇧K anywhere) -------------------------

const palette = createPalette(() => {
  const v = current();
  /** @type {import('./palette.js').Item[]} */
  const items = [];
  for (const s of [...views.values()].sort((a, b) => b.createdAt - a.createdAt)) {
    items.push({ id: `s:${s.id}`, label: s.name, hint: `${folderName(s.cwd)} · ${stateDetail(s)}`, run: () => select(s.id) });
  }
  const act = (/** @type {string} */ label, /** @type {() => void} */ run, hint = '') => items.push({ id: `a:${label}`, label, hint, run });
  act('New session', openNew, 'action');
  act('Show held notifications now', () => void showNow(), 'action');
  const calmButton = (/** @type {string} */ text) => /** @type {HTMLButtonElement | undefined} */ (Array.from(document.querySelectorAll('#calm button')).find((b) => b.textContent === text));
  act('Today', () => calmButton('Today')?.click(), 'action');
  act('Pace settings', () => calmButton('Pace')?.click(), 'action');
  act('Park everything', () => {
    if (confirm('Ask every working session to finish its current step and stop?')) void park().then((r) => notice(r.asked.length ? `Asked ${r.asked.length} to finish and stop.` : 'No session is working right now.'));
  }, 'action');
  if (v) {
    act(`Attach to ${v.name}`, () => media.attach(), 'action');
    act(`Review ${v.name}'s changes`, () => review.setTab('review'), 'action');
    for (const b of Array.from(document.querySelectorAll('#dh [data-act]'))) {
      const what = /** @type {HTMLElement} */ (b).dataset.act;
      // looked up when run: the header re-renders often, and a detached button does nothing
      act(`${b.textContent?.trim()} ${v.name}`, () => /** @type {HTMLButtonElement | null} */ ($('dh').querySelector(`[data-act="${what}"]`))?.click(), 'action');
    }
  }
  return items;
});
if (params.has('palette')) setTimeout(() => palette.open(), 300); // screenshots
if (params.has('review')) setTimeout(() => review.open(params.get('review') || undefined), 300); // screenshots, links
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.code !== 'KeyK' || palette.isOpen || e.isComposing) return;
  const t = /** @type {HTMLElement | null} */ (e.target);
  if (t?.classList?.contains('xterm-helper-textarea')) return; // the terminal handles ⌘⇧K itself
  if (t?.closest?.('input, textarea, [contenteditable]') && !e.metaKey) return; // Ctrl+K edits text there
  e.preventDefault();
  palette.open();
});

// ---- start ----------------------------------------------------------------

if (params.has('new')) {
  openNew();
  cwdIn.value = params.get('new') ?? '';
  checkFolder();
  updateHint();
}

if (SNAP) {
  listSessions().then(onSnapshot, () => onSnapshot([]));
} else {
  events(onSnapshot, onSession, (a) => calm.update(a));
}
// keep the "waiting 4m" times honest
setInterval(() => {
  if (views.size) render();
}, 30_000);
if (!SNAP) createCompatBanner($('compat'));
if (!SNAP) {
  void loadUsage();
  setInterval(loadUsage, 15_000);
} else {
  void loadUsage();
  attention().then((a) => calm.update(a), () => undefined);
}
