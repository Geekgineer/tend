import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { depDir, depMainDir, packageRoot } from './paths.ts';

const ROOT = packageRoot();
const UI = join(ROOT, 'ui');
const XTERM = depDir('@xterm/xterm');
const FIT = depDir('@xterm/addon-fit');
const MARKED = depDir('marked');
const PURIFY = depMainDir('dompurify'); // its exports hide package.json; the main file sits in dist/
const HLJS = depDir('@highlightjs/cdn-assets');

const JS = 'application/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

/** URL path → [absolute file, content type]. Request paths are only ever looked up here, never joined. */
export const STATIC_FILES: Readonly<Record<string, readonly [string, string]>> = {
  '/': [join(UI, 'index.html'), HTML],
  '/ui/styles.css': [join(UI, 'styles.css'), CSS],
  '/ui/api.js': [join(UI, 'api.js'), JS],
  '/ui/list.js': [join(UI, 'list.js'), JS],
  '/ui/terminal.js': [join(UI, 'terminal.js'), JS],
  '/ui/briefing.js': [join(UI, 'briefing.js'), JS],
  '/ui/header.js': [join(UI, 'header.js'), JS],
  '/ui/decision.js': [join(UI, 'decision.js'), JS],
  '/ui/usage.js': [join(UI, 'usage.js'), JS],
  '/ui/calm.js': [join(UI, 'calm.js'), JS],
  '/ui/media.js': [join(UI, 'media.js'), JS],
  '/ui/links.js': [join(UI, 'links.js'), JS],
  '/ui/palette.js': [join(UI, 'palette.js'), JS],
  '/ui/compat.js': [join(UI, 'compat.js'), JS],
  '/ui/review.js': [join(UI, 'review.js'), JS],
  '/ui/external.js': [join(UI, 'external.js'), JS],
  '/ui/review-view.js': [join(UI, 'review-view.js'), JS],
  '/ui/review-model.js': [join(UI, 'review-model.js'), JS],
  '/ui/review-md.js': [join(UI, 'review-md.js'), JS],
  '/ui/review.css': [join(UI, 'review.css'), CSS],
  '/ui/app.js': [join(UI, 'app.js'), JS],
  '/vendor/xterm.js': [join(XTERM, 'lib', 'xterm.js'), JS],
  '/vendor/xterm.css': [join(XTERM, 'css', 'xterm.css'), CSS],
  '/vendor/addon-fit.js': [join(FIT, 'lib', 'addon-fit.js'), JS],
  '/vendor/marked.js': [join(MARKED, 'lib', 'marked.esm.js'), JS],
  '/vendor/purify.js': [join(PURIFY, 'purify.es.mjs'), JS],
  '/vendor/highlight.js': [join(HLJS, 'es', 'highlight.min.js'), JS],
};

export async function serveStatic(res: ServerResponse, path: string): Promise<boolean> {
  const entry = STATIC_FILES[path];
  if (!entry) return false;
  const body = await readFile(entry[0]);
  res.writeHead(200, {
    'content-type': entry[1],
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
  return true;
}

/** Shown at `/` without a token: a calm pointer to the link tend prints, instead of raw JSON. */
export const SIGN_IN_PAGE = `<!doctype html><meta charset="utf-8"><title>tend.</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;background:#0f1113;color:#a0a4ad;display:grid;place-items:center;height:100vh;margin:0}b{color:#e9eaec}</style>
<p><b>tend.</b> Open the link tend printed in your terminal to sign in.</p>`;
