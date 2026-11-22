#!/usr/bin/env node
// Build for installing: Node won't strip TypeScript inside node_modules, so src/*.ts is compiled to dist/src/*.js
// (relative .ts imports rewritten to .js). A checkout still runs src/*.ts directly.
import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
rmSync(join(root, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });
copyFileSync(join(root, 'src', 'folder-panel.jxa'), join(root, 'dist', 'src', 'folder-panel.jxa'));
process.stdout.write('built dist/src\n');
