#!/usr/bin/env node
// The Claude Code compatibility self-test from the command line: one tiny haiku prompt in a temp repo (the same
// check the UI's "Run self-test" runs). Prints the result; exits non-zero on failure.
const { claudeVersion, selfTest } = await import('../../src/compat.ts');
const bin = process.env.TEND_CLAUDE_BIN || 'claude';
const version = await claudeVersion(bin);
const t0 = Date.now();
const missing = await selfTest(bin);
process.stdout.write(JSON.stringify({ version, ok: missing.length === 0, missing, seconds: Math.round((Date.now() - t0) / 1000) }) + '\n');
process.exit(missing.length ? 1 : 0);
