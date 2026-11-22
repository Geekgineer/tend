import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Where Tend's own files are, both in a checkout (src/*.ts) and when installed (dist/src/*.js in node_modules).

/** The folder holding Tend's package.json (walks up from this file). */
export function packageRoot(from = import.meta.dirname): string {
  let dir = from;
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) return join(import.meta.dirname, '..');
    dir = up;
  }
  return dir;
}

const require = createRequire(import.meta.url);

/** A dependency's folder, found the way Node finds modules (works when npm hoists it). */
export function depDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

/** The folder of a dependency's main file (for packages whose exports hide package.json). */
export function depMainDir(name: string): string {
  return dirname(require.resolve(name));
}
