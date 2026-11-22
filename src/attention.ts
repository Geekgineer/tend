import { readFileSync, writeFileSync } from 'node:fs';
import type { NotifyIntent } from './state.ts';
import type { Settings } from './settings.ts';
import { inQuiet } from './settings.ts';

// What interrupts and what waits (spec §22). Only notifications are held; the inbox always shows everything.

/** `need`: a session waiting on you (dropped at release if it no longer is). */
export type Intent = NotifyIntent & { urgent?: boolean; kind?: 'need' | 'stuck' | 'crash' };
export type Held = { sessionId: string; title: string; body: string; at: number; kind?: 'need' | 'stuck' | 'crash'; urgent?: true };
export type AttentionView = { held: Held[]; nextRelease: number | null; quiet: boolean };

const HOUR = 3600_000;

export function createAttention(o: {
  settings: () => Settings;
  deliver: (i: NotifyIntent) => void;
  now?: () => number;
  /** still worth telling? (e.g. the session still needs you); checked at release */
  stillRelevant?: (h: Held) => boolean;
  /** a notification was sent or held (for the wrap-up) */
  record?: (kind: 'sent' | 'held', i: Intent) => void;
  onChange?: () => void;
  /** held items survive a restart: load / save them (e.g. ~/.tend/held.json) */
  load?: () => { held: Held[]; heldInQuiet: number; windowStart: number } | null;
  save?: (state: { held: Held[]; heldInQuiet: number; windowStart: number }) => void;
}) {
  const now = o.now ?? Date.now;
  const loaded = o.load?.() ?? null;
  let held: Held[] = loaded?.held ?? [];
  const sent: number[] = [];
  let windowStart = loaded?.windowStart ?? now();
  let wasQuiet = inQuiet(o.settings(), now());
  // held during quiet hours that ended while Tend was down: the next tick releases them
  if (loaded && loaded.heldInQuiet > 0 && !wasQuiet) wasQuiet = true;
  let heldInQuiet = loaded?.heldInQuiet ?? 0;
  const changed = (): void => {
    o.save?.({ held, heldInQuiet, windowStart });
    o.onChange?.();
  };

  const overBudget = (t: number): boolean => {
    while (sent.length && sent[0]! < t - HOUR) sent.shift();
    return sent.length >= o.settings().budgetPerHour;
  };
  const send = (i: NotifyIntent, t: number): void => {
    sent.push(t);
    o.deliver(i);
  };
  const hold = (i: Intent, t: number): void => {
    // a focus window starts with its first held item; one item per session (the latest says enough),
    // except that an urgent one (stuck, crashed) is never replaced by a lesser one
    if (held.length === 0) windowStart = t;
    const old = held.find((h) => h.sessionId === i.sessionId);
    if (old?.urgent && !i.urgent) return;
    held = held.filter((h) => h.sessionId !== i.sessionId);
    held.push({ sessionId: i.sessionId, title: i.title, body: i.body, at: t, ...(i.kind ? { kind: i.kind } : {}), ...(i.urgent ? { urgent: true as const } : {}) });
    o.record?.('held', i);
    changed();
  };

  /** Send what's held as one notification (or nothing if it's all been dealt with). */
  function release(reason: 'window' | 'now' | 'quiet-ended'): void {
    const t = now();
    const items = held.filter((h) => o.stillRelevant?.(h) ?? true);
    const quietCount = heldInQuiet;
    held = [];
    heldInQuiet = 0;
    windowStart = t;
    changed();
    if (items.length === 0) return;
    const out = (i: NotifyIntent): void => {
      o.record?.('sent', { ...i, urgent: items.some((h) => h.urgent) });
      send(i, t);
    };
    if (items.length === 1 && reason !== 'quiet-ended') {
      out({ sessionId: items[0]!.sessionId, title: items[0]!.title, body: items[0]!.body });
      return;
    }
    const names = items.slice(0, 3).map((h) => h.title);
    const more = items.length > 3 ? ` and ${items.length - 3} more` : '';
    const lead = reason === 'quiet-ended' && quietCount > 0 ? `Held ${quietCount} ${quietCount === 1 ? 'item' : 'items'} during quiet hours. ` : '';
    const title = items.length === 1 ? items[0]!.title : items.every((h) => h.kind === 'need') ? `${items.length} sessions need you` : `${items.length} things to look at`;
    out({ sessionId: items[0]!.sessionId, title, body: `${lead}${names.join(', ')}${more}` });
  }

  return {
    notify(i: Intent): void {
      const t = now();
      const s = o.settings();
      if (inQuiet(s, t)) {
        heldInQuiet++;
        hold(i, t);
        return;
      }
      if (i.urgent || !s.focus.enabled) {
        if (overBudget(t)) hold(i, t);
        else {
          o.record?.('sent', i);
          send(i, t);
        }
        return;
      }
      hold(i, t);
    },
    /** Called every few seconds: releases at the end of a focus window or of quiet hours. */
    tick(): void {
      const t = now();
      const s = o.settings();
      const quiet = inQuiet(s, t);
      if (wasQuiet && !quiet) {
        wasQuiet = false;
        release('quiet-ended');
        return;
      }
      wasQuiet = quiet;
      if (quiet || held.length === 0) return;
      const due = !s.focus.enabled || t - windowStart >= s.focus.minutes * 60_000;
      if (due && !overBudget(t)) release('window');
    },
    showNow(): void {
      release('now');
    },
    view(): AttentionView {
      const s = o.settings();
      const t = now();
      return {
        held: [...held],
        nextRelease: held.length && s.focus.enabled && !inQuiet(s, t) ? windowStart + s.focus.minutes * 60_000 : null,
        quiet: inQuiet(s, t),
      };
    },
    /** A session no longer needs you: drop its held "needs you" item (stuck/crashed/other items stay). */
    drop(sessionId: string): void {
      const before = held.length;
      held = held.filter((h) => !(h.sessionId === sessionId && h.kind === 'need'));
      if (held.length !== before) changed();
    },
  };
}

export type Attention = ReturnType<typeof createAttention>;

/** load/save for createAttention: held items in a 0600 JSON file. */
export function heldFile(file: string) {
  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as { held: Held[]; heldInQuiet: number; windowStart: number };
      } catch {
        return null;
      }
    },
    save: (st: { held: Held[]; heldInQuiet: number; windowStart: number }) => {
      try {
        writeFileSync(file, JSON.stringify(st), { mode: 0o600 });
      } catch {
        // a held list that can't be saved still works in memory
      }
    },
  };
}
