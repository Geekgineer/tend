// "Stuck" (spec §9): ≥ 3 PostToolUseFailure with the same tool and normalised error within 15 min, or no event
// for 10 min while working. The card shows the repeated error verbatim; no "likely cause" (no AI).

export type Stuck = { reason: 'repeating' | 'silent'; tool?: string; error?: string; count?: number; since: number };

export const REPEAT = 3;
export const REPEAT_WINDOW = 15 * 60_000;
export const SILENT = 10 * 60_000;

/** Numbers, hex ids, paths and quoted bits vary between retries; strip them so the same failure matches. */
export function normalise(error: string): string {
  return error
    .slice(0, 2000)
    .replace(/\b0x[0-9a-f]+\b/gi, '<id>')
    .replace(/(\/[\w.@-]+)+/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/(["'`]).*?\1/g, '<q>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function createStuckWatch() {
  const failures = new Map<string, { tool: string; key: string; error: string; at: number }[]>();
  return {
    /**
     * One hook event. Returns the new stuck flag (a value), null to clear it, or undefined for no change.
     */
    onEvent(id: string, kind: string, tool: string | undefined, body: unknown, at: number): Stuck | null | undefined {
      if (kind === 'PostToolUseFailure' && tool) {
        const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        if (b.is_interrupt === true || b.is_interrupt === 'True') return undefined; // the user pressed Esc
        const error = typeof b.error === 'string' ? b.error.slice(0, 2000) : '';
        const key = normalise(error);
        const list = (failures.get(id) ?? []).filter((f) => f.at >= at - REPEAT_WINDOW);
        list.push({ tool, key, error, at });
        failures.set(id, list.slice(-20));
        const same = list.filter((f) => f.tool === tool && f.key === key);
        if (same.length >= REPEAT) return { reason: 'repeating', tool, error, count: same.length, since: same[0]!.at };
        return undefined;
      }
      if (kind === 'PostToolUse' || kind === 'Stop' || kind === 'UserPromptSubmit' || kind === 'SessionEnd' || kind === 'pane_exit' || kind === 'resumed') {
        failures.delete(id);
        return null;
      }
      return undefined;
    },
    /** Silent while working for 10 min? `lastEventAt` is the session's latest event. */
    silent(working: boolean, lastEventAt: number, now: number): Stuck | null {
      return working && now - lastEventAt >= SILENT ? { reason: 'silent', since: lastEventAt } : null;
    },
    forget(id: string): void {
      failures.delete(id);
    },
  };
}
