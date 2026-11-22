// "Park everything" (spec §22): which sessions may receive the "finish your step and stop" message.
// Typing Enter into one of Claude's dialogs would answer it, so anything that might be showing one is skipped.

type View = { id: string; paused: boolean; state: { status: string; since: number }; decisions?: unknown[] };

/** Claude's dialogs (permission, question, trust). */
export const DIALOG = /Do you want to proceed\?|Esc to cancel|Enter to confirm|^\s*❯\s*\d+\./m;

/** Working sessions with no card waiting, not changed in the last 2 s, and no dialog on screen. */
export function parkable<V extends View>(views: V[], screen: (id: string) => string, now: number): V[] {
  return views.filter((v) => {
    if (v.state.status !== 'working' || v.paused || v.decisions?.length || now - v.state.since < 2000) return false;
    try {
      const text = screen(v.id).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      return !DIALOG.test(text.split('\n').filter((l) => l.trim()).slice(-15).join('\n'));
    } catch {
      return false;
    }
  });
}
