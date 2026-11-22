export type OverlapInput = { id: string; commonDir: string; changed: string[] };
export type Overlap = { files: string[]; with: string[] };

const sharedFiles = (a: string[], b: string[]): string[] => {
  const set = new Set(b);
  return a.filter((f) => set.has(f));
};

/** Per session: the files it shares with any other session of the same repo, and who those are. */
export function computeOverlaps(items: OverlapInput[]): Map<string, Overlap> {
  const files = new Map<string, Set<string>>();
  const withs = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, id: string, vs: string[]): void => {
    const s = m.get(id) ?? new Set<string>();
    for (const v of vs) s.add(v);
    m.set(id, s);
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.commonDir !== b.commonDir) continue;
      const shared = sharedFiles(a.changed, b.changed);
      if (shared.length === 0) continue;
      add(files, a.id, shared);
      add(files, b.id, shared);
      add(withs, a.id, [b.id]);
      add(withs, b.id, [a.id]);
    }
  }
  const out = new Map<string, Overlap>();
  for (const [id, f] of files) out.set(id, { files: [...f].sort(), with: [...withs.get(id)!].sort() });
  return out;
}

/** Pairs [a, b, shared files] (a < b) present in `next` but not in `prev`. */
export function newPairs(prev: Map<string, Overlap>, next: Map<string, Overlap>): Array<[string, string, string[]]> {
  const out: Array<[string, string, string[]]> = [];
  for (const [a, o] of [...next].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    for (const b of o.with) {
      if (b < a || prev.get(a)?.with.includes(b)) continue;
      const other = next.get(b);
      const shared = other ? o.files.filter((f) => other.files.includes(f)) : o.files;
      out.push([a, b, shared]);
    }
  }
  return out;
}
