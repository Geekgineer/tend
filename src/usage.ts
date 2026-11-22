// Context and usage from Claude Code's status line JSON (spec §9.1). No credentials, no usage API: only
// what Claude already hands to its status line. Pure functions; the registry keeps the state.

export type CacheView = { warm: boolean; expiresAt: number | null; recacheTokens: number | null };
export type ContextView = {
  /** used_percentage; null until the first turn */
  pct: number | null;
  tokens: number;
  size: number | null;
  model: string | null;
  cache: CacheView | null;
  /** when Tend saw it (ms) */
  at: number;
  /** pct is the last known value (Claude reported null, e.g. right after /compact) */
  stale?: true;
};
export type Window = { pct: number; resetsAt: number };
export type Limits = { fiveHour: Window | null; sevenDay: Window | null };
export type Status = { context: ContextView; limits: Limits; sessionTokens: number };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v: number | null, lo: number, hi: number): number | null => (v === null ? null : Math.min(hi, Math.max(lo, v)));
const DAY = 24 * 3600_000;
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

function window(v: unknown, now: number): Window | null {
  const w = obj(v);
  const pct = clamp(num(w.used_percentage), 0, 100);
  const resets = num(w.resets_at);
  // a reset time must be plausible: within the next 8 days (weekly window) and not long gone
  if (pct === null || resets === null || resets * 1000 < now - DAY || resets * 1000 > now + 8 * DAY) return null;
  return { pct, resetsAt: resets * 1000 };
}

/** Read one status line JSON. `prev` keeps the last context % when Claude reports null. */
export function parseStatus(body: unknown, now: number, prev?: ContextView): Status {
  const b = obj(body);
  const cw = obj(b.context_window);
  const tokens = Math.min(1e10, Math.max(0, (num(cw.total_input_tokens) ?? 0) + (num(cw.total_output_tokens) ?? 0)));
  const pc = obj(b.prompt_cache);
  const cache: CacheView | null =
    typeof pc.warm === 'boolean'
      ? {
          warm: pc.warm,
          expiresAt: (() => {
            const e = num(pc.expires_at);
            return e === null || e * 1000 < now - DAY || e * 1000 > now + DAY ? null : e * 1000;
          })(),
          recacheTokens: clamp(num(pc.recache_tokens_if_cold), 0, 1e10),
        }
      : null;
  let pct = clamp(num(cw.used_percentage), 0, 100);
  let stale: true | undefined;
  if (pct === null && prev?.pct != null) {
    pct = prev.pct;
    stale = true;
  }
  const model = obj(b.model);
  const context: ContextView = {
    pct,
    tokens,
    size: clamp(num(cw.context_window_size), 0, 1e9),
    model: typeof model.display_name === 'string' ? model.display_name.slice(0, 80) : null,
    cache,
    at: now,
  };
  if (stale) context.stale = stale;
  const rl = obj(b.rate_limits);
  return { context, limits: { fiveHour: window(rl.five_hour, now), sevenDay: window(rl.seven_day, now) }, sessionTokens: tokens };
}

export type Zone = 'chill' | 'on_pace' | 'warning' | 'hot';
export const FIVE_HOURS = 5 * 3600_000;
export const SEVEN_DAYS = 7 * 24 * 3600_000;
const HYSTERESIS = 3;

/**
 * Pacing zone (spec §9.1): projected = used / elapsed fraction of the window.
 * hot: used ≥ 90 or projected ≥ 115 · warning: used ≥ 75 or projected ≥ 100 · chill: projected < 75 · else on pace.
 * Leaving a zone needs a 3-point margin. The first 10% of a window is low confidence.
 */
export function pace(w: Window, length: number, now: number, prev?: Zone): { zone: Zone; projected: number; confident: boolean } {
  const start = w.resetsAt - length;
  const elapsed = Math.min(1, Math.max(0, (now - start) / length));
  const confident = elapsed >= 0.1;
  // early in a window the projection means little (2% at 1% elapsed is not "hot"): judge by used % alone
  const projected = w.pct / Math.max(elapsed, 0.1);
  const zoneAt = (m: number): Zone => {
    if (w.pct >= 90 - m || (confident && projected >= 115 - m)) return 'hot';
    if (w.pct >= 75 - m || (confident && projected >= 100 - m)) return 'warning';
    if (!confident || projected < 75 - m) return 'chill';
    return 'on_pace';
  };
  let zone = zoneAt(0);
  if (prev && prev !== zone) {
    const order: Zone[] = ['chill', 'on_pace', 'warning', 'hot'];
    // moving down (calmer) needs the margin; moving up is immediate
    if (order.indexOf(zone) < order.indexOf(prev) && order.indexOf(zoneAt(HYSTERESIS)) >= order.indexOf(prev)) zone = prev;
  }
  return { zone, projected: Math.round(projected), confident };
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const span = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

/** One sentence of projection for a window, in pacing language (not "limits"). */
export function projection(w: Window, length: number, now: number): string {
  const start = w.resetsAt - length;
  const elapsed = now - start;
  if (w.pct >= 100) return `Used up until ${clock(w.resetsAt)}.`;
  if (elapsed <= 0 || w.pct <= 0) return `Resets at ${clock(w.resetsAt)}.`;
  const rate = w.pct / elapsed; // % per ms
  const full = now + (100 - w.pct) / rate;
  if (full >= w.resetsAt) return `At this pace you stay under it; resets at ${clock(w.resetsAt)}.`;
  return `At this pace you reach it around ${clock(full)}, ${span(w.resetsAt - full)} before it resets.`;
}

export type Sample = { at: number; tokens: number };
export const SHARE_WINDOW = 30 * 60_000;

/** Tokens a session used in the window, from its samples (oldest first). A drop (compaction) counts from the drop. */
export function tokensUsed(samples: Sample[], now: number, span = SHARE_WINDOW): number {
  const recent = samples.filter((s) => s.at >= now - span && s.at <= now);
  let used = 0;
  for (let i = 1; i < recent.length; i++) used += Math.max(0, recent[i]!.tokens - recent[i - 1]!.tokens);
  return used;
}
