import pkg from '@xterm/headless'; const { Terminal } = pkg;
import { execFileSync, spawn } from 'node:child_process';
const T = (...a) => execFileSync('tmux', ['-L', 'tend', ...a]).toString();
const term = new Terminal({ cols: 150, rows: 42, allowProposedApi: true });
const dec = (s) => Buffer.from(s, 'base64'); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
term.write(dec(await (await fetch('http://127.0.0.1:4980/snapshot')).text()));
const res = await fetch('http://127.0.0.1:4980/stream'); const rd = res.body.getReader(); let buf = '';
(async () => { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += Buffer.from(value).toString(); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); if (ev.startsWith('data: ')) term.write(dec(ev.slice(6))); } } })();
const cmp = (label, rows) => { const b = term.buffer.active; const tm = T('capture-pane', '-p', '-t', 'a1').split('\n'); let d = 0; for (let y = 0; y < rows; y++) { const x = (b.getLine(b.baseY + y)?.translateToString(true) ?? '').trimEnd(); if (x !== (tm[y] || '').trimEnd()) d++; } console.log(`${label}: ${d} of ${rows} lines differ`); };
await wait(1000); cmp('150x42 baseline', 42);
// browser-driven resize: window-size manual, Tend resizes the window, xterm resizes to match
T('resize-window', '-t', 'a1', '-x', '120', '-y', '35'); term.resize(120, 35); await wait(1500);
// Claude redraws on SIGWINCH; nudge a redraw so both views settle, then compare
term.write(dec(await (await fetch('http://127.0.0.1:4980/snapshot')).text())); await wait(800); cmp('after resize to 120x35 (+resnapshot)', 35);
// a second ordinary client attaches at a different size: with window-size manual the window must not change
const other = spawn('tmux', ['-L', 'tend', 'attach', '-t', 'a1'], { stdio: 'ignore', detached: true }); await wait(1500);
console.log('window size with 2nd client:', T('display', '-p', '-t', 'a1', '#{window_width}x#{window_height}').trim());
try { process.kill(-other.pid); } catch {}
process.exit(0);
