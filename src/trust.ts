import type { TendEvent } from './events.ts';
import type { SessionView } from './sessions.ts';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const TRUST_TEXT = /trust this folder/i;
// a dialog option line, numbered or not (Claude Code 2.1.312 draws '❯ No, exit' / '  Yes, I trust this folder')
const OPTION = /^\s*(❯\s*)?(\d+\.\s+)?(Yes|No)\b/;
const TAIL_LINES = 15;

/** The dialog is on screen: its phrase and its numbered option list are both in the last lines of the pane. */
export function showsTrustDialog(pane: string): boolean {
  const tail = pane.replace(ANSI, '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(-TAIL_LINES);
  return tail.some((l) => TRUST_TEXT.test(l)) && tail.some((l) => OPTION.test(l));
}

/**
 * Claude's "trust this folder" dialog sends no hook, so it is read from the pane of starting
 * (or trust-waiting) sessions. Tend never answers it and never writes ~/.claude.json.
 * Claude records trust per git repo, so after the first session in a repo it isn't shown again.
 */
export function createTrustCheck(deps: {
  views: () => Iterable<SessionView>;
  snapshot: (id: string) => Buffer;
  apply: (view: SessionView, ev: TendEvent) => void;
  now: () => number;
}): () => void {
  return () => {
    for (const view of [...deps.views()]) {
      const s = view.state;
      const waiting = s.status === 'needs_you' && s.need === 'trust';
      if (s.status !== 'starting' && !waiting) continue;
      let text: string;
      try {
        text = deps.snapshot(view.id).toString('utf8');
      } catch {
        continue;
      }
      const shown = showsTrustDialog(text);
      if (shown === waiting) continue;
      deps.apply(view, { ts: deps.now(), sessionId: view.id, kind: shown ? 'trust_prompt' : 'trust_done', data: null });
    }
  };
}
