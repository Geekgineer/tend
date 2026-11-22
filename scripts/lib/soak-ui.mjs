// The production soak's UI oracle: the page itself must never freeze or go stale. It checks how fast the page
// answers, main-thread blocks, what the page shows vs what the server knows, and the terminal vs Claude's real screen.

/**
 * @param {{ page: any, sessions: () => Promise<any[]>, screenOf: (id: string) => Promise<string>, plan: any[],
 *   find: (kind: string, detail: string, session?: string, screen?: string) => void,
 *   strike: (id: string, key: string, ok: boolean) => number, metrics: any, sleep: (ms: number) => Promise<void>,
 *   doing: () => string }} o
 */
export function createUiOracle({ page, sessions, screenOf, plan, find, strike, metrics, sleep, doing: now }) {
  return async function uiOracle() {
    const doing = now();
    const t0 = performance.now();
    await page.js('return 1');
    const ping = performance.now() - t0;
    metrics.ui.ping.push(ping);
    if (ping > 3000) find('ui-stuck', `the page took ${Math.round(ping)} ms to answer (while ${doing})`);
    const long = /** @type {number[]} */ (await page.js(`const l = window.__long ?? []; window.__long = []; return l;`));
    metrics.ui.blocks += long.length;
    metrics.ui.longest = Math.max(metrics.ui.longest, ...long);
    for (const d of long) if (d > 1500) find('ui-freeze', `the page was frozen for ${d} ms (while ${doing})`);
    // what the page shows vs what the server knows (a page that stopped getting updates looks "stuck")
    const list = await sessions();
    // the state class on the list rows and strip tiles (the same kind() the page renders from) vs the server
    const shownKind = /** @type {Record<string, string>} */ (await page.js(`const o = {};
      for (const t of document.querySelectorAll('#strip [data-id], #list [data-id]')) o[t.dataset.id] = t.className;
      return o;`));
    for (const p of plan) {
      const v = list.find((x) => x.id === p.id);
      if (!v) continue;
      const want = v.paused ? 'paused' : v.state.status === 'needs_you' ? (v.state.need ?? 'permission') : v.state.status;
      const shown = shownKind[p.id] ?? '(not shown)';
      if (strike(p.id, 'ui-state', shown.split(' ').includes(want)) >= 3) find('ui-stale', `the page shows "${shown}", the server says ${want}`, p.name);
    }
    // the terminal on screen vs Claude's real screen, for the selected session on the Terminal tab
    const sel = /** @type {{ id: string, tab: string, rows: string } | null} */ (await page.js(`const s = document.querySelector('#strip .sel')?.dataset.id; if (!s) return null;
      return { id: s, tab: document.querySelector('.dtabs button.on')?.textContent ?? '', rows: [...document.querySelectorAll('#termHost .xterm-rows > div')].map((d) => d.textContent).join('\\n') };`));
    if (sel && sel.tab.startsWith('Terminal') && !doing.startsWith('typing')) {
      const v = list.find((x) => x.id === sel.id);
      const p = plan.find((x) => x.id === sel.id);
      if (v && p && !v.paused && v.state.status !== 'ended' && !p.hold) {
        const norm = (/** @type {string} */ x) => x.replace(/\s+/g, ' ').trim();
        const rowsNow = async () => norm(String(await page.js(`return [...document.querySelectorAll('#termHost .xterm-rows > div')].map((d) => d.textContent).join(' ')`)));
        let real = (await screenOf(sel.id)).split('\n').map(norm).filter((l) => l.length > 3).slice(-3);
        let same = real.every((l) => sel.rows && norm(sel.rows).includes(l));
        for (let i = 0; i < 3 && !same; i++) {
          // the two reads are a moment apart while output streams: look again before calling it stale
          await sleep(700);
          real = (await screenOf(sel.id)).split('\n').map(norm).filter((l) => l.length > 3).slice(-3);
          const shown = await rowsNow();
          same = real.every((l) => shown.includes(l));
        }
        if (strike(sel.id, 'term', same) >= 3) find('terminal-stale', 'the terminal in the page stopped matching Claude\'s screen', p.name, real.join('\n'));
      }
    }
  
  };
}
