import type { Account } from './accounts.ts';
import type { NotifyIntent } from './state.ts';
import type { Store } from './store.ts';
import { FIVE_HOURS, pace, parseStatus, projection, SEVEN_DAYS, SHARE_WINDOW, tokensUsed } from './usage.ts';
import type { ContextView, Sample, Window, Zone } from './usage.ts';

export type WindowView = Window & { zone: Zone; projected: number; confident: boolean; projection: string };
export type AccountUsage = {
  dir: string;
  name: string;
  fiveHour: WindowView | null;
  sevenDay: WindowView | null;
  /** when the limits were last seen (ms); null = never */
  at: number | null;
  /** sessions by share of tokens used in the last 30 min */
  top: { id: string; name: string; share: number }[];
};

type Seen = { fiveHour: Window | null; sevenDay: Window | null; at: number; zone?: Zone; hotWindow?: number };

const PERSIST_MS = 10_000;
/** One sample per 10 s (later updates refresh it), so 30 minutes fit for a busy session too. */
const SAMPLE_EVERY = 10_000;
const MAX_SAMPLES = 400;

export function createUsageTracker(o: {
  store: Store;
  notify: (i: NotifyIntent) => void;
  now: () => number;
  accounts: () => Account[];
  /** live sessions: id → { name, account dir } */
  sessions: () => Map<string, { name: string; account: string }>;
}) {
  const samples = new Map<string, Sample[]>();
  const seen = new Map<string, Seen>();
  const persisted = new Map<string, number>();
  for (const { dir, json } of o.store.listUsage()) {
    try {
      seen.set(dir, JSON.parse(json) as Seen);
    } catch {
      // ignore a broken row
    }
  }

  const view = (w: Window | null, length: number, now: number, prev?: Zone): WindowView | null => {
    if (!w) return null;
    if (w.resetsAt <= now) return null; // that window is over; the next status brings the new one
    const p = pace(w, length, now, prev);
    return { ...w, ...p, projection: projection(w, length, now) };
  };

  const top = (dir: string, now: number): AccountUsage['top'] => {
    const used: { id: string; name: string; tokens: number }[] = [];
    for (const [id, s] of o.sessions()) {
      if (s.account !== dir) continue;
      const t = tokensUsed(samples.get(id) ?? [], now);
      if (t > 0) used.push({ id, name: s.name, tokens: t });
    }
    const total = used.reduce((a, b) => a + b.tokens, 0);
    return used
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5)
      .map((u) => ({ id: u.id, name: u.name, share: Math.round((u.tokens / total) * 100) }));
  };

  return {
    /** One status line update from a session. Returns its context view. */
    ingest(sessionId: string, account: string, body: unknown, prev?: ContextView): ContextView {
      const now = o.now();
      const st = parseStatus(body, now, prev);
      const list = samples.get(sessionId) ?? [];
      const last = list[list.length - 1];
      const prevLast = list[list.length - 2];
      if (last && prevLast && now - prevLast.at < SAMPLE_EVERY) {
        last.at = now;
        last.tokens = st.sessionTokens;
      } else list.push({ at: now, tokens: st.sessionTokens });
      while (list.length > MAX_SAMPLES || (list[0] && list[0].at < now - SHARE_WINDOW - 60_000)) list.shift();
      samples.set(sessionId, list);

      if (st.limits.fiveHour || st.limits.sevenDay) {
        const old = seen.get(account);
        const next: Seen = { fiveHour: st.limits.fiveHour ?? old?.fiveHour ?? null, sevenDay: st.limits.sevenDay ?? old?.sevenDay ?? null, at: now };
        if (old?.hotWindow !== undefined) next.hotWindow = old.hotWindow;
        const five = view(next.fiveHour, FIVE_HOURS, now, old?.zone);
        if (five) next.zone = five.zone;
        // one notification per 5-hour window when its pace turns hot
        // keyed on the reset time to the minute, so jitter in resets_at is still the same window
        const windowKey = Math.round(five ? five.resetsAt / 60_000 : 0);
        if (five?.zone === 'hot' && five.confident && next.hotWindow !== windowKey) {
          next.hotWindow = windowKey;
          const heaviest = top(account, now)[0];
          const others = o.accounts().filter((a) => a.dir !== account);
          const name = o.accounts().find((a) => a.dir === account)?.name ?? 'This account';
          o.notify({
            sessionId: heaviest?.id ?? sessionId,
            title: 'Keeping a sustainable pace',
            body:
              `${name}: 5-hour use at ${Math.round(five.pct)}%${heaviest ? `, most by ${heaviest.name}` : ''}.` +
              (others.length ? ` New work could go to ${others[0]!.name}.` : ''),
          });
        }
        seen.set(account, next);
        if (now - (persisted.get(account) ?? 0) >= PERSIST_MS || next.hotWindow !== old?.hotWindow) {
          persisted.set(account, now);
          o.store.putUsage(account, JSON.stringify(next));
        }
      }
      return st.context;
    },

    /** Every account with what's known about it. */
    list(): AccountUsage[] {
      const now = o.now();
      const accounts = o.accounts();
      return accounts.map((a) => {
        const s = seen.get(a.dir);
        return {
          dir: a.dir,
          name: a.name,
          fiveHour: view(s?.fiveHour ?? null, FIVE_HOURS, now, s?.zone),
          sevenDay: view(s?.sevenDay ?? null, SEVEN_DAYS, now),
          at: s?.at ?? null,
          top: top(a.dir, now),
        };
      });
    },

    /**
     * The account with the most 5-hour headroom among those reporting recently (an account never seen isn't
     * assumed to be logged in), or null when none is. Only used when the user explicitly asks for it.
     */
    roomiest(): string | null {
      const now = o.now();
      let best: string | null = null;
      let bestPct = Infinity;
      for (const a of o.accounts()) {
        const s = seen.get(a.dir);
        const w = s?.fiveHour;
        if (!s || !w || w.resetsAt <= now || now - s.at > 6 * 3600_000) continue;
        if (w.pct < bestPct) {
          best = a.dir;
          bestPct = w.pct;
        }
      }
      return best;
    },

    /** Save the latest usage of every account (on shutdown; updates are otherwise saved every 10 s). */
    flush(): void {
      for (const [dir, s] of seen) o.store.putUsage(dir, JSON.stringify(s));
    },

    forget(sessionId: string): void {
      samples.delete(sessionId);
    },
  };
}

export type UsageTracker = ReturnType<typeof createUsageTracker>;
