// @ts-check
// Calm (spec §22): held notifications and "Show now", quiet hours, settings, the Today wrap-up, Park
// everything, and "Since you left". Pace language, not limits. textContent only.

/** @typedef {import('./api.js').Settings} Settings */
/** @typedef {import('./api.js').AttentionView} AttentionView */
/** @typedef {import('./api.js').Wrapup} Wrapup */

/** Away at least this long and the tab says what happened meanwhile. */
export const AWAY_MS = 5 * 60_000;

/** `1 h 20 min` of waiting. @param {number} ms */
export function duration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
}

/** @param {number} n @param {string} one @param {string} [many] */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The "Since you left" line, or null when nothing happened. @param {Wrapup} w @param {number} waitingNow */
export function sinceYouLeft(w, waitingNow) {
  /** @type {string[]} */
  const parts = [];
  if (w.finished) parts.push(`${plural(w.finished, 'turn')} finished`);
  if (w.decisions) parts.push(`${plural(w.decisions, 'request')} for you`);
  if (w.commits) parts.push(plural(w.commits, 'commit'));
  if (waitingNow) parts.push(`${waitingNow} waiting on you now`);
  return parts.length ? `Since you left: ${parts.join(', ')}.` : null;
}

/** The note in New session when you're at your own limit, or null. @param {number} active @param {number} limit */
export function wipNote(active, limit) {
  if (active < limit) return null;
  return `You have ${plural(active, 'session')} going; your limit is ${limit}. Starting another is fine; finishing one first is calmer.`;
}

/** Wrap-up rows for the Today panel. @param {Wrapup} w */
export function wrapupRows(w) {
  return [
    ['Decisions', String(w.decisions)],
    ['Turns finished', String(w.finished)],
    ['Sessions started', String(w.started)],
    ['Commits', String(w.commits)],
    ['Interruptions', `${w.interruptions.sent} sent · ${w.interruptions.held} held`],
    ['Time waiting on you', duration(w.waiting)],
  ];
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const hhmm = (/** @type {number} */ t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * @param {HTMLElement} host  top bar slot
 * @param {{
 *   showNow: () => Promise<unknown>, getSettings: () => Promise<Settings>, saveSettings: (s: unknown) => Promise<Settings>,
 *   wrapup: (since?: number) => Promise<Wrapup>, park: () => Promise<{ asked: string[] }>, onNotice: (msg: string) => void,
 * }} api
 */
export function createCalm(host, api) {
  /** @type {AttentionView} */
  let att = { held: [], nextRelease: null, quiet: false };
  /** @type {Settings | null} */
  let settings = null;
  /** @type {HTMLElement | null} */
  let pop = null;
  const close = () => {
    pop?.remove();
    pop = null;
  };
  document.addEventListener('click', (e) => {
    if (pop && !(e.target instanceof Node && (pop.contains(e.target) || host.contains(e.target)))) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  /** @param {HTMLElement} panel */
  const show = (panel) => {
    close();
    pop = panel;
    host.append(panel);
  };

  async function today() {
    const panel = el('div', 'cpop');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Today');
    panel.append(el('div', 'chead', 'Today'));
    show(panel);
    try {
      const w = await api.wrapup();
      const list = el('dl', 'crows');
      for (const [k, v] of wrapupRows(w)) list.append(el('dt', '', k), el('dd', 'num', v));
      panel.append(list);
    } catch {
      panel.append(el('p', 'cmuted', 'Could not load today.'));
    }
    const park = /** @type {HTMLButtonElement} */ (el('button', 'btn', 'Park everything'));
    park.type = 'button';
    park.title = 'Ask every working session to finish its current step and stop';
    park.addEventListener('click', async () => {
      if (!confirm('Ask every working session to finish its current step and stop?')) return;
      try {
        const r = await api.park();
        api.onNotice(r.asked.length ? `Asked ${plural(r.asked.length, 'session')} to finish and stop.` : 'No session is working right now.');
      } catch (x) {
        api.onNotice(x instanceof Error ? x.message : 'Could not park.');
      }
      close();
    });
    panel.append(el('p', 'cmuted', 'The cost of attention, not only the output.'), park);
  }

  async function prefs() {
    const panel = el('form', 'cpop');
    panel.setAttribute('aria-label', 'Pace settings');
    panel.append(el('div', 'chead', 'Pace'));
    show(panel);
    let s;
    try {
      s = settings = await api.getSettings();
    } catch {
      panel.append(el('p', 'cmuted', 'Could not load settings.'));
      return;
    }
    /** @param {string} label @param {HTMLElement} input @param {string} [hint] */
    const row = (label, input, hint) => {
      const r = el('label', 'cfield');
      r.append(el('span', '', label), input);
      if (hint) r.append(el('small', 'cmuted', hint));
      panel.append(r);
    };
    /** @param {boolean} on */
    const check = (on) => Object.assign(/** @type {HTMLInputElement} */ (el('input')), { type: 'checkbox', checked: on });
    /** @param {number} v @param {number} min @param {number} max */
    const num = (v, min, max) => Object.assign(/** @type {HTMLInputElement} */ (el('input')), { type: 'number', value: String(v), min: String(min), max: String(max) });
    /** @param {string} v */
    const time = (v) => Object.assign(/** @type {HTMLInputElement} */ (el('input')), { type: 'time', value: v });
    const focusOn = check(s.focus.enabled);
    const focusMin = num(s.focus.minutes, 5, 240);
    const quietOn = check(s.quiet.enabled);
    const qStart = time(s.quiet.start);
    const qEnd = time(s.quiet.end);
    const budget = num(s.budgetPerHour, 1, 60);
    const wip = num(s.wipLimit, 1, 100);
    row('Focus windows', focusOn, 'Only high-risk requests, stuck and crashed sessions interrupt; the rest arrives together.');
    row('Every (minutes)', focusMin);
    row('Quiet hours', quietOn, 'Nothing notifies; you get one summary when they end.');
    const span = el('span', 'cspan');
    span.append(qStart, el('span', 'cmuted', 'to'), qEnd);
    row('From', span);
    row('At most per hour', budget);
    row('Sessions at once (soft)', wip, 'A gentle note when you start more. Nothing is blocked.');
    const err = el('p', 'cerr');
    const save = /** @type {HTMLButtonElement} */ (el('button', 'btn pri', 'Save'));
    save.type = 'submit';
    panel.append(err, save);
    panel.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        settings = await api.saveSettings({
          focus: { enabled: focusOn.checked, minutes: Number(focusMin.value) },
          quiet: { enabled: quietOn.checked, start: qStart.value, end: qEnd.value },
          budgetPerHour: Number(budget.value),
          wipLimit: Number(wip.value),
        });
        close();
        render();
      } catch (x) {
        err.textContent = x instanceof Error ? x.message : 'Could not save.';
      }
    });
  }

  function render() {
    /** @type {HTMLElement[]} */
    const items = [];
    if (att.quiet) items.push(el('span', 'cquiet', settings ? `Quiet until ${settings.quiet.end}` : 'Quiet hours'));
    if (att.held.length) {
      const b = /** @type {HTMLButtonElement} */ (el('button', 'cheld'));
      b.type = 'button';
      b.title = `${att.held.map((h) => h.title).join(', ')}${att.nextRelease ? ` · next at ${hhmm(att.nextRelease)}` : ''}`;
      b.append(el('span', 'num', `${att.held.length} held`), el('span', 'cshow', 'Show now'));
      b.addEventListener('click', () => api.showNow().catch(() => api.onNotice('Could not release the held notifications.')));
      items.push(b);
    }
    const t = /** @type {HTMLButtonElement} */ (el('button', 'btn ghost', 'Today'));
    t.type = 'button';
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      void today();
    });
    const g = /** @type {HTMLButtonElement} */ (el('button', 'btn ghost icon'));
    g.type = 'button';
    g.title = 'Pace settings';
    g.setAttribute('aria-label', 'Pace settings');
    g.textContent = 'Pace';
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      void prefs();
    });
    const keep = pop;
    host.replaceChildren(...items, t, g);
    if (keep) host.append(keep);
  }

  // "Since you left": a line when the tab comes back after a while
  let hiddenAt = /** @type {number | null} */ (null);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const since = hiddenAt;
    hiddenAt = null;
    if (since === null || Date.now() - since < AWAY_MS) return;
    try {
      const line = sinceYouLeft(await api.wrapup(since), att.held.length);
      if (line) api.onNotice(line);
    } catch {
      // best effort
    }
  });

  api.getSettings().then(
    (s) => {
      settings = s;
      render();
      // `today` / `pace` URL parameters open those panels (screenshots)
      const q = new URLSearchParams(location.search);
      if (q.has('today')) void today();
      else if (q.has('pace')) void prefs();
    },
    () => render(),
  );

  return {
    /** @param {AttentionView} a */
    update(a) {
      att = a;
      render();
    },
    /** The current settings (null until loaded). */
    get settings() {
      return settings;
    },
  };
}
