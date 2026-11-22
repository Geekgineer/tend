// Feed the bridge stream into a headless xterm and compare with tmux's own view.
import pkg from '@xterm/headless'; const { Terminal } = pkg;
import { execFileSync } from 'node:child_process';
const term = new Terminal({ cols: 150, rows: 42, allowProposedApi: true });
const dec = (s) => Buffer.from(s, 'base64');
term.write(dec(await (await fetch('http://127.0.0.1:4980/snapshot')).text()));
const res = await fetch('http://127.0.0.1:4980/stream');
const reader = res.body.getReader(); let buf = '';
(async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += Buffer.from(value).toString();
  let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); if (ev.startsWith('data: ')) term.write(dec(ev.slice(6))); } } })();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const screen = () => { const b = term.buffer.active, out = []; for (let y = 0; y < term.rows; y++) out.push((b.getLine(b.baseY + y)?.translateToString(true) ?? '').trimEnd()); return out; };
const tmuxScreen = () => execFileSync('tmux', ['-L', 'tend', 'capture-pane', '-p', '-t', 's1']).toString().split('\n').slice(0, 42).map((l) => l.trimEnd());
const compare = (label) => { const a = screen(), b = tmuxScreen(); let diff = 0; for (let y = 0; y < 42; y++) if ((a[y] || '') !== (b[y] || '')) { diff++; if (diff <= 3) console.log(`  line ${y}\n   xterm: ${JSON.stringify(a[y])}\n   tmux : ${JSON.stringify(b[y])}`); } console.log(`${label}: ${diff} of 42 lines differ`); };
await wait(1500); compare('after snapshot');
// trigger a permission dialog through the stream
await fetch('http://127.0.0.1:4977/mode?perm=hold');
execFileSync('tmux', ['-L', 'tend', 'send-keys', '-t', 's1', '-l', 'Create a file named four.txt containing four. Do nothing else.']);
execFileSync('tmux', ['-L', 'tend', 'send-keys', '-t', 's1', 'Enter']);
await wait(15000); compare('with permission dialog (streamed)');
// keys through the bridge: Escape to cancel the dialog via /keys
await fetch('http://127.0.0.1:4980/keys', { method: 'POST', body: '\x1b' }); await wait(3000);
await fetch('http://127.0.0.1:4980/keys', { method: 'POST', body: 'typed via bridge' }); await wait(2000);
compare('after keys via bridge');
console.log('prompt line contains typed text:', tmuxScreen().some((l) => l.includes('typed via bridge')));
process.exit(0);
