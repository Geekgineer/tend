#!/usr/bin/env node
// v0.1 "lint": size limit, dependency allowlist, syntax check, no console.log in src.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const MAX_LINES = 600;
const ALLOWED = new Set(['@xterm/xterm', '@xterm/addon-fit', 'marked', 'dompurify', '@highlightjs/cdn-assets', 'typescript', '@types/node', '@xterm/headless']);
const problems = [];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (relative(root, p) === join('test', 'fixtures')) continue;
      out.push(...walk(p));
    } else out.push(p);
  }
  return out;
}

const files = ['src', 'ui', 'bin', 'scripts', 'test'].flatMap((d) => {
  try {
    return walk(join(root, d));
  } catch {
    return [];
  }
});

for (const f of files) {
  const rel = relative(root, f);
  const text = readFileSync(f, 'utf8');
  const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  if (lines > MAX_LINES) problems.push(`${rel}: ${lines} lines (max ${MAX_LINES})`);
  if (/\.mjs$/.test(rel) || /^ui\/[^/]+\.js$/.test(rel)) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      problems.push(`${rel}: node --check failed: ${String(/** @type {{ stderr?: unknown; message?: unknown }} */ (e).stderr ?? /** @type {Error} */ (e).message).split('\n')[0]}`);
    }
  }
  if (rel.startsWith('src/') && /\bconsole\.log\b/.test(text)) problems.push(`${rel}: contains console.log`);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const section of ['dependencies', 'devDependencies']) {
  for (const name of Object.keys(pkg[section] ?? {})) {
    if (!ALLOWED.has(name)) problems.push(`package.json ${section}: "${name}" is not on the allowlist`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`check failed:\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`check ok: ${files.length} files, size/deps/syntax/console.log all clean\n`);
