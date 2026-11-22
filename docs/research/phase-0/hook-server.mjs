// Spike: records every hook / status-line payload; can hold PermissionRequest open.
// Usage: node hook-server.mjs [port]   Control: GET /mode?perm=hold|allow|deny|none
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] || 4977);
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
fs.mkdirSync(dir, { recursive: true });
let permMode = 'none';            // none = return {} ; hold = wait for /release ; allow/deny = answer now
const held = [];                  // pending PermissionRequest responses
let n = fs.readdirSync(dir).length;

function save(kind, body) {
  const file = path.join(dir, `${String(++n).padStart(3, '0')}-${kind}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  console.log(new Date().toISOString(), kind, file);
}
const decision = (behavior) => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, ...(behavior === 'deny' ? { message: 'Denied from Tend spike' } : {}) } },
});

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/mode') {
    permMode = url.searchParams.get('perm') || permMode;
    res.end(`perm=${permMode}\n`); return;
  }
  if (req.method === 'GET' && url.pathname === '/approve-plan') {
    const r = held.shift(); if (!r) { res.end('nothing held\n'); return; }
    r.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: r.tendBody.tool_input } } }));
    res.end('plan approved\n'); return;
  }
  if (req.method === 'GET' && url.pathname === '/answer') {
    const r = held.shift(); if (!r) { res.end('nothing held\n'); return; }
    const qs = r.tendBody.tool_input.questions; const label = url.searchParams.get('label');
    const out = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { questions: qs, answers: { [qs[0].question]: label } } } } };
    r.end(JSON.stringify(out)); res.end('answered ' + label + '\n'); return;
  }
  if (req.method === 'GET' && url.pathname === '/release') {
    const b = url.searchParams.get('behavior') || 'allow';
    const r = held.shift();
    if (r) { r.end(JSON.stringify(decision(b))); res.end(`released ${b}, ${held.length} left\n`); }
    else res.end('nothing held\n');
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body; try { body = JSON.parse(raw); } catch { body = { raw }; }
    const kind = url.pathname.replace(/^\//, '').replace(/\//g, '_') || 'unknown';
    save(kind === 'hook' ? (body.hook_event_name || 'hook') : kind, { headers: { 'x-tend-token': req.headers['x-tend-token'] }, body });
    if (body.hook_event_name === 'PermissionRequest') {
      if (permMode === 'hold') { held.push(res); res.tendBody = body; req.on("close", () => console.log("  held request closed by client")); res.on("close", () => console.log("  held response closed")); console.log('  holding permission', held.length); return; }
      if (permMode === 'allow' || permMode === 'deny') { res.end(JSON.stringify(decision(permMode))); return; }
    }
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
}).listen(port, '127.0.0.1', () => console.log('spike hook server on', port));
