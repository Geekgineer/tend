import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

// Realistic multi-turn work for the production soak: each session gets a list of turns a developer would send.
// `plan: true` switches the session into plan mode first; `attach` pastes an image before the prompt.

/** @typedef {{ text: string, plan?: boolean, attach?: number[] }} Turn */

/** @type {Record<string, Turn[]>} */
export const TASKS = {
  slugs: [
    { text: 'Look at how src/session-util.ts is organised. Then add src/soak/text.ts exporting slugify(text: string): string (lowercase, words joined by dashes, punctuation removed). Add test/unit/soak-text.test.ts using node:test and run it with: node --test test/unit/soak-text.test.ts' },
    { text: 'Make slugify turn accented letters into plain ones (é becomes e) and collapse repeated dashes. Update the test and run it again.' },
    { text: 'Add truncate(text: string, max: number) to src/soak/text.ts that adds an ellipsis when it cuts, with tests, and run them.' },
    { text: 'Check src/soak/text.ts for edge cases (empty string, only punctuation, very long input) and fix what you find. Run the tests.' },
    { text: 'Commit your work: git add -A && git commit -m "soak: text helpers"' },
  ],
  kebab: [
    { text: 'Add a function kebabCase(s: string): string to src/soak/text.ts (create the file if it does not exist) and a test in test/unit/soak-kebab.test.ts. Run it with node --test.' },
    { text: 'Use the AskUserQuestion tool to ask me whether kebabCase should keep digits, with exactly two options: Keep and Drop. Then implement what I pick and rerun the test.' },
    { text: 'Run the whole soak test pair: node --test test/unit/soak-text.test.ts test/unit/soak-kebab.test.ts and fix anything that fails.' },
    { text: 'Commit your work: git add -A && git commit -m "soak: kebab case"' },
  ],
  inventory: [
    { text: 'There is a bug in inventory.py: total() returns the wrong amount. Find it, fix it, and add test_inventory.py runnable with: python3 -m unittest -v. Run it.' },
    { text: 'Present a short plan with ExitPlanMode for adding remove_item(name) to inventory.py with a test. After I approve, implement it and run the tests.', plan: true },
    { text: 'Run this to clean up: rm -rf build' },
    { text: 'Add type hints to inventory.py and run the tests again.' },
  ],
  notes: [
    { text: 'What single colour fills the attached image? Then write notes.md with one sentence describing it. Image: ', attach: [200, 40, 40] },
    { text: 'Create checklist.md with five short items for planning a team offsite.' },
    { text: 'Use the AskUserQuestion tool to ask me which of the first three checklist items matters most (those three as options). Then mark my pick in checklist.md.' },
    { text: 'Read notes.md and checklist.md and summarise both in two lines.' },
  ],
};

/** Follow-ups once a session's list is done, so the soak keeps realistic load to the end. */
export const FOLLOW_UPS = [
  'List the files you changed in this session and why, in at most four lines.',
  'Is there anything in what you wrote that a reviewer would question? Fix the most important one if it is quick.',
  'Show git status and git diff --stat for your work.',
];

/** A small Python project with one real bug (for the "inventory" session). */
export const INVENTORY_PY = `"""A tiny inventory."""

items = {}


def add_item(name, price, qty=1):
    items[name] = {"price": price, "qty": qty}


def total():
    # bug: forgets the last item
    names = list(items)
    return sum(items[n]["price"] * items[n]["qty"] for n in names[:-1])
`;

/** A 48×48 PNG of one colour (an image to attach). */
export function png(/** @type {number[]} */ rgb) {
  const chunk = (/** @type {string} */ ty, /** @type {Buffer} */ d) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(ty, 'latin1'), d]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([head, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(48, 0);
  ihdr.writeUInt32BE(48, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 48 }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 48 }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** A hash of every tracked and untracked file in a folder (not .git, not .tend). @param {string} dir */
export function treeHash(dir) {
  const h = createHash('sha256');
  const walk = (/** @type {string} */ d) => {
    for (const n of readdirSync(d).sort()) {
      if (n === '.git' || n === '.tend' || n === 'node_modules') continue;
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(relative(dir, p)).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}
