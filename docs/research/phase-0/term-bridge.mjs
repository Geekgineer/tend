// Spike: stream a tmux pane to xterm.js through tmux control mode (no native pty).
// Usage: node term-bridge.mjs <session> [port]
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const session = process.argv[2] || 's1';
const port = Number(process.argv[3] || 4980);
const tmux = (...a) => execFileSync('tmux', ['-L', 'tend', ...a]).toString();
const clients = new Set();
let backlog = [];

// tmux control mode escapes non-printables and backslash as \ooo octal.
function decode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && /^[0-7]{3}$/.test(s.slice(i + 1, i + 4))) { out.push(parseInt(s.slice(i + 1, i + 4), 8)); i += 3; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}
const send = (buf) => { const line = `data: ${buf.toString('base64')}\n\n`; for (const c of clients) c.write(line); };

const cc = spawn('tmux', ['-L', 'tend', '-C', 'attach', '-t', session], { stdio: ['pipe', 'pipe', 'inherit'] });
let acc = '';
cc.stdout.setEncoding('latin1'); // keep raw bytes 1:1; octal escapes carry the rest
cc.stdout.on('data', (d) => {
  acc += d; let i;
  while ((i = acc.indexOf('\n')) >= 0) {
    const line = acc.slice(0, i); acc = acc.slice(i + 1);
    if (line.startsWith('%output ')) {
      const rest = line.slice(8); const sp = rest.indexOf(' ');
      const bytes = decode(Buffer.from(rest.slice(sp + 1), 'latin1').toString('latin1'));
      backlog.push(bytes); if (backlog.length > 2000) backlog = backlog.slice(-1000);
      send(bytes);
    }
  }
});
cc.stdin.write('refresh-client -C 150,42\n');

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<style>body{margin:0;background:#0b0c0e}#t{padding:12px}</style></head><body><div id="t"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script>
const term = new Terminal({cols:150, rows:42, fontFamily:'Menlo, monospace', fontSize:13, theme:{background:'#0b0c0e'}, allowProposedApi:true});
term.open(document.getElementById('t'));
const dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
fetch('/snapshot').then(r=>r.text()).then(s=>{ term.write(dec(s)); if (location.search.includes('snap')) return; const es = new EventSource('/stream'); es.onmessage = e => term.write(dec(e.data)); });
term.onData(d => fetch('/keys', {method:'POST', body:d}));
window.__term = term;
</script></body></html>`;

http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) { res.setHeader('content-type', 'text/html'); res.end(page); return; }
  if (req.url === '/snapshot') {
    // current screen with escapes, then cursor position, so the stream continues from a correct state
    const screen = tmux('capture-pane', '-p', '-e', '-t', session);
    const [cx, cy] = tmux('display', '-p', '-t', session, '#{cursor_x} #{cursor_y}').trim().split(' ').map(Number);
    const buf = Buffer.from('\x1b[2J\x1b[H' + screen.replace(/\n/g, '\r\n').replace(/\r\n$/, '') + `\x1b[${cy + 1};${cx + 1}H`);
    res.end(buf.toString('base64')); return;
  }
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(':ok\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (req.url === '/keys' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      // send raw keys as hex so every byte (Esc, arrows, Enter) arrives exactly
      const hex = [...Buffer.from(b, 'utf8')].map((x) => x.toString(16).padStart(2, '0')).join(' ');
      cc.stdin.write(`send-keys -t ${session} -H ${hex}\n`); res.end('ok');
    }); return;
  }
  res.statusCode = 404; res.end();
}).listen(port, '127.0.0.1', () => console.log('bridge on', port));
