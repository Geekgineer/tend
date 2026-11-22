import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitWatch, DEBOUNCE_MS } from '../../src/git-watch.ts';
import type { WatchTarget } from '../../src/git-watch.ts';
import type { GitFacts } from '../../src/git.ts';

const facts = (changed: string[]): GitFacts => ({ branch: 'b', ahead: null, behind: null, uncommitted: changed.length, commits: 0, changed });
const target = (id: string): WatchTarget => ({ id, name: id, dir: `/${id}`, base: null, commonDir: null, eligible: true });

test('a transient facts() error keeps the last facts of a still-eligible session', async () => {
  let fail = false;
  const set = new Map<string, GitFacts | undefined>();
  const w = createGitWatch({
    targets: () => [target('a')],
    set: (id, git) => set.set(id, git),
    notify: () => {},
    facts: async () => {
      if (fail) throw new Error('index.lock');
      return facts(['x.ts']);
    },
  });
  await w.refresh();
  assert.deepEqual(set.get('a'), facts(['x.ts']));
  fail = true;
  await w.refresh();
  assert.deepEqual(set.get('a'), facts(['x.ts']));
  w.close();
});

test('cached facts of a session that left the targets are dropped', async () => {
  let targets = [target('a')];
  let calls = 0;
  const set = new Map<string, GitFacts | undefined>();
  const w = createGitWatch({
    targets: () => targets,
    set: (id, git) => set.set(id, git),
    notify: () => {},
    facts: async () => {
      calls++;
      if (calls > 1) throw new Error('transient');
      return facts(['x.ts']);
    },
  });
  await w.refresh();
  targets = []; // archived
  await w.refresh();
  targets = [target('a')]; // the same id again (cannot happen for real, but the cache must not resurrect it)
  await w.refresh();
  assert.equal(set.get('a'), undefined);
  w.close();
});

test('schedule works when called detached from the watcher object', async () => {
  let calls = 0;
  const w = createGitWatch({
    targets: () => [target('a')],
    set: () => {},
    notify: () => {},
    facts: async () => {
      calls++;
      return facts([]);
    },
  });
  const { schedule } = w;
  schedule('a');
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
  assert.equal(calls, 1);
  w.close();
});
