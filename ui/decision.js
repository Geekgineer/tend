// @ts-check
// The decision card above the briefing: answer a permission, a question or a plan without leaving
// the page. Built with textContent only. Card answers go through the hook; they never type keys.
import { decide } from './api.js';
import { cacheWarning } from './usage.js';

/** @typedef {import('./api.js').SessionView} SessionView */
/** @typedef {import('./api.js').DecisionView} DecisionView */

/** Shortcuts are ignored this long after the selected session changes (guards a mis-hit during a switch). */
export const SWITCH_GUARD_MS = 500;
/** A high-risk Allow must be confirmed within this window. */
export const CONFIRM_MS = 5000;

const VERB = { Bash: 'run', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', WebFetch: 'fetch', WebSearch: 'search' };

/** One line for the list row and notifications. @param {DecisionView} d */
export function summary(d) {
  if (d.kind === 'question') return d.questions?.[0]?.question ?? 'Has a question';
  if (d.kind === 'plan') return 'Plan ready for approval';
  const what = d.command ?? d.filePath ?? d.url ?? d.tool;
  const verb = /** @type {Record<string, string>} */ (VERB)[d.tool];
  return verb ? `Wants to ${verb} ${what}` : `Wants to use ${d.tool}: ${what}`;
}

/**
 * May a single-key shortcut act right now?
 * @param {{ target: EventTarget | null, risk?: string, sinceSelect: number }} o
 */
export function shortcutAllowed({ target, risk, sinceSelect }) {
  if (risk === 'high') return false;
  if (sinceSelect < SWITCH_GUARD_MS) return false;
  const el = /** @type {HTMLElement | null} */ (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement ? target : null);
  if (el && (el.closest('.term, input, textarea, select, [contenteditable], dialog') || el.isContentEditable)) return false;
  return true;
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
/** @param {string} label @param {string} cls @param {() => void} onClick @param {string} [key] */
function button(label, cls, onClick, key) {
  const b = /** @type {HTMLButtonElement} */ (el('button', `btn ${cls}`, label));
  b.type = 'button';
  if (key) {
    b.dataset.key = key;
    b.append(el('kbd', '', key.toUpperCase()));
  }
  b.addEventListener('click', onClick);
  return b;
}

/**
 * @param {HTMLElement} host
 * @param {{ onError: (msg: string) => void, focusTerminal: () => void }} hooks
 */
export function createDecisionCard(host, hooks) {
  /** @type {SessionView | null} */
  let view = null;
  /** @type {string | null} */
  let shownId = null;
  let selectedAt = 0;
  let sending = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let confirmTimer;

  /** Answer the card that was drawn (never whatever is first by the time this runs). @param {string} did @param {Record<string, unknown>} body */
  async function send(did, body) {
    if (!view || sending || !view.decisions?.some((x) => x.id === did)) return;
    sending = true;
    host.querySelectorAll('button').forEach((b) => ((/** @type {HTMLButtonElement} */ (b)).disabled = true));
    try {
      await decide(view.id, did, body);
    } catch (x) {
      hooks.onError(x instanceof Error ? x.message : 'Could not send the answer.');
    } finally {
      sending = false;
      host.querySelectorAll('button').forEach((b) => ((/** @type {HTMLButtonElement} */ (b)).disabled = false));
    }
  }

  /** @param {DecisionView} d */
  function permission(d) {
    const card = el('div', 'dbody');
    const head = el('div', 'dhead');
    const verb = /** @type {Record<string, string>} */ (VERB)[d.tool];
    head.append(el('span', 'dq', verb ? `Wants to ${verb}` : `Wants to use ${d.tool}`));
    if (d.risk) {
      const r = el('span', `risk ${d.risk.level}`, `${d.risk.level === 'high' ? 'High risk' : d.risk.level === 'medium' ? 'Medium risk' : 'Low risk'} · ${d.risk.rule}`);
      head.append(r);
    }
    card.append(head);
    const subject = d.command ?? d.filePath ?? d.url;
    if (subject) card.append(el('pre', 'dcmd', subject));
    if (d.description) card.append(el('p', 'ddesc', d.description));
    const acts = el('div', 'dacts');
    const high = d.risk?.level === 'high';
    const allow = button(high ? 'Allow…' : 'Allow', 'pri', () => {
      if (!high) {
        void send(d.id, { action: 'allow' });
        return;
      }
      if (allow.dataset.armed === '1') {
        void send(d.id, { action: 'allow', confirm: true });
        return;
      }
      allow.dataset.armed = '1';
      allow.textContent = 'Confirm allow';
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        allow.dataset.armed = '';
        allow.textContent = 'Allow…';
      }, CONFIRM_MS);
    }, high ? undefined : 'a');
    acts.append(allow);
    if (d.canAlways) acts.append(button(d.alwaysLabel ?? 'Always allow this session', '', () => void send(d.id, { action: 'always' })));
    const note = /** @type {HTMLInputElement} */ (el('input', 'dnote'));
    note.placeholder = 'Note for Claude (optional)';
    note.maxLength = 2000;
    acts.append(button('Deny', '', () => void send(d.id, note.value.trim() ? { action: 'deny', message: note.value } : { action: 'deny' }), high ? undefined : 'd'), note);
    card.append(acts);
    return card;
  }

  /** @param {DecisionView} d */
  function question(d) {
    const card = el('div', 'dbody');
    const qs = d.questions ?? [];
    if (d.terminalOnly) {
      for (const q of qs) card.append(el('p', 'dq', q.question));
      const acts = el('div', 'dacts');
      acts.append(el('span', 'dhint', 'Pick several answers in the terminal.'), button('Answer in the terminal', '', hooks.focusTerminal));
      card.append(acts);
      return card;
    }
    /** @type {Record<string, string>} */
    const picked = {};
    let n = 0;
    // several questions: pick each, then send them together (one question sends on the pick)
    const sendAll = button('Send answers', 'pri', () => void send(d.id, { action: 'answers', answers: picked }));
    sendAll.disabled = true;
    for (const q of qs) {
      if (q.header) card.append(el('span', 'dtag', q.header));
      card.append(el('p', 'dq', q.question));
      const opts = el('div', 'dopts');
      for (const o of q.options) {
        n++;
        const key = n <= 9 ? String(n) : undefined;
        const b = button('', 'opt', () => {
          picked[q.question] = o.label;
          opts.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          if (qs.length === 1) void send(d.id, { action: 'answers', answers: picked });
          else sendAll.disabled = !qs.every((x) => picked[x.question]);
        });
        const top = el('span', 'olab', o.label);
        if (key) {
          b.dataset.key = key;
          top.append(el('kbd', '', key));
        }
        b.prepend(top);
        if (o.description) {
          b.title = o.description;
          b.append(el('span', 'odesc', o.description));
        }
        opts.append(b);
      }
      card.append(opts);
    }
    if (qs.length > 1) {
      const acts = el('div', 'dacts');
      acts.append(sendAll);
      card.append(acts);
    }
    return card;
  }

  /** @param {DecisionView} d */
  function plan(d) {
    const card = el('div', 'dbody');
    card.append(el('p', 'dq', 'Plan ready for approval'), el('pre', 'dplan', d.plan ?? ''));
    const acts = el('div', 'dacts');
    const note = /** @type {HTMLInputElement} */ (el('input', 'dnote'));
    note.placeholder = 'What to change (optional)';
    note.maxLength = 2000;
    acts.append(
      button('Approve plan', 'pri', () => void send(d.id, { action: 'approve' }), 'a'),
      button('Keep planning', '', () => void send(d.id, note.value.trim() ? { action: 'deny', message: note.value } : { action: 'deny', message: 'Keep planning.' }), 'd'),
      note,
    );
    card.append(acts);
    return card;
  }

  function render() {
    const d = view?.decisions?.[0];
    const waiting = view && !d && view.state.status === 'needs_you' && !view.paused;
    const problem = view && !d && !waiting && (view.stuck || view.crashed) ? view : null;
    host.hidden = !d && !waiting && !problem;
    if (!d) {
      shownId = null;
      if (problem) {
        const p = el('div', 'dbody');
        if (problem.crashed) p.append(el('p', 'dq', 'Session ended unexpectedly'), el('p', 'dhint', 'Its scrollback is kept. Resume continues the same conversation.'));
        else if (problem.stuck?.reason === 'silent') p.append(el('p', 'dq', 'Stuck: no progress for 10 minutes while working'));
        else if (problem.stuck) {
          p.append(el('p', 'dq', `Stuck: the same ${problem.stuck.tool} error ${problem.stuck.count} times`));
          if (problem.stuck.error) p.append(el('pre', 'dcmd', problem.stuck.error));
        }
        if (!problem.crashed) {
          const acts = el('div', 'dacts');
          acts.append(button('Look in the terminal', '', hooks.focusTerminal));
          p.append(acts);
        }
        host.replaceChildren(p);
        host.classList.remove('high');
      } else if (waiting) {
        const p = el('div', 'dbody');
        const acts = el('div', 'dacts');
        acts.append(el('span', 'dhint', 'Claude is waiting for you in the terminal.'), button('Answer in the terminal', '', hooks.focusTerminal));
        p.append(acts);
        host.replaceChildren(p);
      } else host.replaceChildren();
      return;
    }
    if (d.id === shownId) {
      // keep a half-typed note and an armed confirm; only refresh the cache countdown
      const cold = cacheWarning(view?.context, Date.now());
      const line = host.querySelector('.dcache');
      if (line) line.textContent = cold ?? '';
      else if (cold) host.firstElementChild?.append(el('p', 'dcache', cold));
      return;
    }
    shownId = d.id;
    selectedAt = Date.now(); // a key meant for the previous card must not answer this one
    clearTimeout(confirmTimer);
    const body = d.kind === 'question' ? question(d) : d.kind === 'plan' ? plan(d) : permission(d);
    const more = (view?.decisions?.length ?? 1) - 1;
    if (more > 0) body.append(el('span', 'dmore', `${more} more waiting`));
    const cold = cacheWarning(view?.context, Date.now());
    if (cold) body.append(el('p', 'dcache', cold));
    host.replaceChildren(body);
    host.classList.toggle('high', d.risk?.level === 'high');
  }

  document.addEventListener('keydown', (e) => {
    const d = view?.decisions?.[0];
    if (!d || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (!shortcutAllowed({ target: e.target, risk: d.risk?.level, sinceSelect: Date.now() - selectedAt })) return;
    const b = /** @type {HTMLButtonElement | null} */ (host.querySelector(`button[data-key="${CSS.escape(e.key.toLowerCase())}"]`));
    if (!b || b.disabled) return;
    e.preventDefault();
    b.click();
  });

  return {
    /** @param {SessionView | null} v */
    update(v) {
      if (v?.id !== view?.id) {
        selectedAt = Date.now();
        shownId = null;
        sending = false; // an answer in flight for another session must not block this one
      }
      view = v;
      render();
    },
  };
}
