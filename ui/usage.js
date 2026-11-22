// @ts-check
// Usage pills (top bar) and their popover, context rings and cache facts. All from Claude's own status line
// (no usage API). Framed as keeping a sustainable pace, not as limits. textContent only.

/** @typedef {import('./api.js').AccountUsage} AccountUsage */
/** @typedef {import('./api.js').WindowView} WindowView */
/** @typedef {import('./api.js').ContextView} ContextView */

export const FIVE_HOURS = 5 * 3600_000;
export const SEVEN_DAYS = 7 * 24 * 3600_000;
/** Older than this, a usage number is shown greyed with "as of". */
export const STALE_MS = 15 * 60_000;
/** Warn on a pending decision when the prompt cache goes cold sooner than this. */
export const CACHE_WARN_MS = 3 * 60_000;

/** `1 h 58 min` / `12 min` / `now`. @param {number} ms */
export function left(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m === 0) return 'now';
  if (m >= 24 * 60) return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
  if (m >= 60) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
  return `${m} min`;
}

/** `108k` / `1M`. @param {number} n */
export function tokens(n) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Where even pace sits on the bar (0–100). @param {WindowView} w @param {number} length @param {number} now */
export const evenPace = (w, length, now) => Math.min(100, Math.max(0, ((now - (w.resetsAt - length)) / length) * 100));

/** Ring class for a context %, or null when there's nothing to show (< 60%). @param {number | null | undefined} pct */
export function ringLevel(pct) {
  if (pct == null || pct < 60) return null;
  return pct > 85 ? 'hot' : pct >= 70 ? 'warn' : 'calm';
}

/** A 14 px context ring for a list row, as an HTML string (numbers only). @param {ContextView | undefined} c */
export function ringHTML(c) {
  const lvl = ringLevel(c?.pct);
  if (!lvl || !c || c.pct == null) return '';
  const pct = Math.min(100, Math.round(c.pct));
  const len = 2 * Math.PI * 5.5;
  return `<svg class="ring ${lvl}" viewBox="0 0 14 14" aria-label="Context ${pct}%"><title>Context ${pct}%</title><circle cx="7" cy="7" r="5.5"/><circle class="v" cx="7" cy="7" r="5.5" stroke-dasharray="${((pct / 100) * len).toFixed(1)} ${len.toFixed(1)}"/></svg>`;
}

/** Facts-line text for a session's context and cache. @param {ContextView | undefined} c @param {number} now */
export function contextFacts(c, now) {
  /** @type {{ text: string, cls?: string, title?: string }[]} */
  const out = [];
  if (!c) return out;
  if (c.pct != null) {
    const size = c.size ? ` · ${tokens(c.tokens)} / ${tokens(c.size)}` : '';
    out.push({
      text: `context ${Math.round(c.pct)}%${size}${c.pct >= 80 ? ' · auto-compact soon' : ''}`,
      cls: c.pct >= 80 ? 'warn' : c.stale ? 'stale' : undefined,
      title: c.stale ? 'Last known value (Claude reported none since, e.g. after /compact)' : undefined,
    });
  }
  if (c.cache) {
    if (c.cache.warm && c.cache.expiresAt && c.cache.expiresAt > now) out.push({ text: `cache warm · ${left(c.cache.expiresAt - now)} left` });
    else out.push({ text: 'cache cold', title: c.cache.recacheTokens ? `The next answer re-reads about ${tokens(c.cache.recacheTokens)} tokens` : undefined });
  }
  return out;
}

/** The cache warning on a pending decision, or null. @param {ContextView | undefined} c @param {number} now */
export function cacheWarning(c, now) {
  const exp = c?.cache?.warm ? c.cache.expiresAt : null;
  if (!c || !exp || exp <= now || exp - now > CACHE_WARN_MS) return null;
  const re = c.cache?.recacheTokens ? ` Answering after that re-reads about ${tokens(c.cache.recacheTokens)} tokens.` : '';
  return `Prompt cache goes cold in ${left(exp - now)}.${re}`;
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A bar: fill by %, coloured by zone, with an even-pace tick. @param {WindowView} w @param {number} length @param {number} now */
function bar(w, length, now) {
  const b = el('span', `ubar ${w.zone}`);
  const fill = el('i');
  fill.style.width = `${Math.min(100, w.pct)}%`;
  const tick = el('b');
  tick.style.left = `${evenPace(w, length, now)}%`;
  b.append(fill, tick);
  return b;
}

const ZONE_TEXT = { chill: 'Plenty of room', on_pace: 'On pace', warning: 'Running warm', hot: 'Running hot' };

/**
 * @param {HTMLElement} host  where the pills go (top bar)
 * @param {{ onSelect: (id: string) => void }} hooks
 */
export function createUsage(host, hooks) {
  /** @type {AccountUsage[]} */
  let accounts = [];
  /** @type {HTMLElement | null} */
  let pop = null;

  function close() {
    pop?.remove();
    pop = null;
  }
  document.addEventListener('click', (e) => {
    if (pop && !(e.target instanceof Node && (pop.contains(e.target) || host.contains(e.target)))) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  /** @param {AccountUsage} a @param {boolean} multi */
  function section(a, multi) {
    const now = Date.now();
    const s = el('div', 'usec');
    if (multi) s.append(el('div', 'uname', a.name));
    const stale = a.at !== null && now - a.at > STALE_MS;
    /** @param {string} label @param {WindowView | null} w @param {number} length */
    const row = (label, w, length) => {
      const r = el('div', 'urow');
      if (!w) {
        r.append(el('span', 'ulab', label), el('span', 'umuted', 'No data yet'));
        return r;
      }
      r.append(el('span', 'ulab', label), bar(w, length, now), el('span', 'upct num', `${Math.round(w.pct)}%`), el('span', 'umuted', `resets in ${left(w.resetsAt - now)}`));
      return r;
    };
    s.append(row('5 hours', a.fiveHour, FIVE_HOURS), row('Week', a.sevenDay, SEVEN_DAYS));
    if (a.fiveHour) {
      s.append(el('p', 'uproj', `${ZONE_TEXT[a.fiveHour.zone]}. ${a.fiveHour.projection}${a.fiveHour.confident ? '' : ' (early in the window)'}`));
    }
    if (stale && a.at) s.append(el('p', 'umuted', `As of ${new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: no session of this account is reporting.`));
    if (a.top.length) {
      s.append(el('div', 'ulab', 'Using the most (30 min)'));
      const list = el('div', 'utop');
      for (const t of a.top) {
        const b = /** @type {HTMLButtonElement} */ (el('button', 'utopi'));
        b.type = 'button';
        b.append(el('span', '', t.name), el('span', 'num umuted', `${t.share}%`));
        b.addEventListener('click', () => {
          close();
          hooks.onSelect(t.id);
        });
        list.append(b);
      }
      s.append(list);
    }
    return s;
  }

  /** @param {HTMLElement} anchor */
  function open(anchor) {
    close();
    pop = el('div', 'upop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Usage');
    const multi = accounts.length > 1;
    for (const a of accounts) pop.append(section(a, multi));
    if (!accounts.some((a) => a.fiveHour || a.sevenDay)) pop.append(el('p', 'umuted', 'Usage appears once a session reports (Pro and Max plans).'));
    anchor.after(pop);
  }

  function render() {
    const now = Date.now();
    const multi = accounts.length > 1;
    const shown = accounts.filter((a) => a.fiveHour);
    host.replaceChildren(
      ...shown.map((a, i) => {
        const w = /** @type {WindowView} */ (a.fiveHour);
        const stale = a.at !== null && now - a.at > STALE_MS;
        const b = /** @type {HTMLButtonElement} */ (el('button', `upill${stale ? ' stale' : ''}`));
        b.type = 'button';
        b.title = `${multi ? `${a.name}: ` : ''}5-hour use ${Math.round(w.pct)}% · ${ZONE_TEXT[w.zone]} · resets in ${left(w.resetsAt - now)}`;
        if (multi) b.append(el('span', `udot a${i % 4}`));
        b.append(el('span', 'ulab', '5h'), bar(w, FIVE_HOURS, now), el('span', 'upct num', `${Math.round(w.pct)}%`), el('span', 'umuted num', left(w.resetsAt - now)));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (pop) close();
          else open(host);
        });
        return b;
      }),
    );
  }

  return {
    /** @param {AccountUsage[]} next */
    update(next) {
      accounts = next;
      render();
      if (pop) open(host); // keep an open popover current
    },
    get accounts() {
      return accounts;
    },
    /** Open the popover (the `usage` URL parameter, for screenshots). */
    show() {
      if (accounts.length) open(host);
    },
  };
}
