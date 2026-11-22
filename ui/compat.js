// @ts-check
// "Claude Code X hasn't been checked with Tend yet" (spec §20): one banner, an on-demand self-test, the result.

/** @typedef {{ version: string | null, verified: boolean, last: { version: string, ok: boolean, missing: string[], at: number } | null, running: boolean }} Compat */

/** The banner text for a compat state, or null when there's nothing to say. @param {Compat} c */
export function bannerText(c) {
  if (!c.version || c.verified) return null;
  if (c.last && c.last.version === c.version && !c.last.ok) {
    return `Claude Code ${c.version}: the self-test found problems (${c.last.missing.join(', ')}). Cards may fall back to answering in the terminal; sessions keep working.`;
  }
  return `Claude Code ${c.version} hasn't been checked with Tend yet. Everything should work; a self-test makes sure (one tiny prompt, about 1K tokens).`;
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** @param {HTMLElement} host */
export function createCompatBanner(host) {
  let dismissed = '';
  try {
    dismissed = localStorage.getItem('tend.compatLater') ?? '';
  } catch {
    // private window: just this tab
  }
  async function load() {
    try {
      const r = await fetch('/api/compat');
      if (r.ok) render(/** @type {Compat} */ (await r.json()));
    } catch {
      // best effort
    }
  }
  /** @param {Compat} c */
  function render(c) {
    const text = bannerText(c);
    host.hidden = !text || dismissed === c.version;
    if (!text) return;
    const run = /** @type {HTMLButtonElement} */ (el('button', 'btn', c.running ? 'Running…' : 'Run self-test'));
    run.type = 'button';
    run.disabled = c.running;
    run.addEventListener('click', async () => {
      run.disabled = true;
      run.textContent = 'Running… (up to 2 min)';
      try {
        const r = await fetch('/api/compat/selftest', { method: 'POST' });
        if (!r.ok) throw new Error();
      } catch {
        // the reload below shows the outcome
      }
      void load();
    });
    const later = /** @type {HTMLButtonElement} */ (el('button', 'btn ghost', 'Later'));
    later.type = 'button';
    later.addEventListener('click', () => {
      dismissed = c.version ?? '';
      try {
        localStorage.setItem('tend.compatLater', dismissed); // until the version changes
      } catch {
        // fine
      }
      host.hidden = true;
    });
    host.replaceChildren(el('span', 'ctext', text), run, later);
  }
  void load();
  setInterval(load, 30 * 60_000);
}
