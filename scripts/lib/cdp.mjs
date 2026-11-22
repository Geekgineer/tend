// A tiny Chrome DevTools Protocol driver for the browser e2e and soak scripts: start headless Chrome, open a page,
// evaluate, click, type, press keys. No dependencies (Node's own WebSocket).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

export async function openBrowser() {
  const profile = mkdtempSync(join(tmpdir(), 'tend-cdp-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1600,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    const t = setTimeout(() => reject(new Error(`Chrome did not start: ${err}`)), 15_000);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
  });
  const ws = new WebSocket(/** @type {string} */ (wsUrl));
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const waiting = new Map();
  /** @type {((m: any) => void)[]} */
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else for (const l of listeners) l(m);
  };
  /** @param {string} method @param {object} [params] @param {string} [sessionId] @returns {Promise<any>} */
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  /** Open a page; returns helpers bound to it. */
  async function page() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (/** @type {string} */ m, /** @type {object} */ p = {}) => send(m, p, sessionId);
    const errors = /** @type {string[]} */ ([]);
    listeners.push((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((/** @type {any} */ a) => a.value ?? a.description).join(' '));
      if (m.method === 'Page.javascriptDialogOpening') void s('Page.handleJavaScriptDialog', { accept: true });
    });
    await s('Runtime.enable');
    await s('Page.enable');
    /** @param {string} body an async function body */
    const js = async (body) => {
      const r = await s('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const until = async (/** @type {string} */ body, /** @type {string} */ what, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(body).catch(() => false)) return;
        await sleep(100);
      }
      throw new Error(`timed out waiting for: ${what}`);
    };
    const click = (/** @type {string} */ sel, /** @type {string} */ text = '') => js(`
      const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => !${JSON.stringify(text)} || e.textContent.includes(${JSON.stringify(text)}));
      if (!el) throw new Error('no element ' + ${JSON.stringify(`${sel} ${text}`)});
      el.click(); return true;`);
    const VK = /** @type {Record<string, number>} */ ({ Enter: 13, Escape: 27, ArrowDown: 40 });
    const key = async (/** @type {string} */ k, /** @type {string} */ code, modifiers = 0) => {
      const text = k === 'Enter' ? '\r' : k.length === 1 && !modifiers ? k : undefined;
      const vk = VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
      await s('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
      await s('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
    };
    const typeText = async (/** @type {string} */ text) => {
      for (const ch of text) await s('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    };
    return { s, js, until, click, key, typeText, errors, navigate: (/** @type {string} */ url) => s('Page.navigate', { url }) };
  }

  return {
    page,
    close() {
      try {
        ws.close();
      } catch {
        // gone
      }
      proc.kill('SIGKILL');
      // Chrome may still be writing its profile for a moment after the kill: retry, and never fail the run over it
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // a leftover temp folder is harmless
      }
    },
  };
}
