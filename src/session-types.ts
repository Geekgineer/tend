// The registry's public shapes: what the server and the UI see of a session.
import type { SessionState } from './state.ts';
import type { GitFacts } from './git.ts';
import type { Overlap } from './overlap.ts';
import type { Answer, DecisionView, Held } from './decisions.ts';
import type { ContextView } from './usage.ts';
import type { Stuck } from './stuck.ts';
import type { Account } from './accounts.ts';
import type { AccountUsage } from './usage-tracker.ts';
import type { Briefing } from './briefing.ts';
import type { Saved } from './attachments.ts';

export type WorkspaceView = { mode: 'inplace' } | { mode: 'worktree'; branch: string; worktree: string };

export type SessionView = {
  id: string;
  name: string;
  cwd: string;
  state: SessionState;
  createdAt: number;
  workspace: WorkspaceView;
  paused: boolean;
  archived?: true;
  git?: GitFacts;
  overlap?: Overlap;
  /** Pending permission requests, questions and plans, oldest first (held hooks; gone after a restart). */
  decisions?: DecisionView[];
  /** Context and prompt cache from its status line (the last value seen; `at` tells how old). */
  context?: ContextView;
  /** The Claude config folder (account) it runs under. */
  account: string;
  /** Repeating the same failure, or silent for 10 min while working. */
  stuck?: Stuck;
  /** Ended without Claude saying so (pane died), not by Pause or Archive. */
  crashed?: true;
};

export type Registry = {
  /** `resume`: adopt a closed Claude session (its id); it runs in place, where its transcript lives. */
  create(o: { cwd: string; name?: string; isolate?: boolean; account?: string; resume?: string }): SessionView & { warning?: string };
  /** A status line update (context, cache, usage) from a session's live launch. */
  status(sessionId: string, body: unknown, launch: string | undefined): boolean;
  /** Usage per account, with pacing and the sessions using the most. */
  usage(): AccountUsage[];
  accounts(): Account[];
  list(): SessionView[];
  get(id: string): SessionView | undefined;
  ingest(sessionId: string, body: unknown, launch?: string): boolean;
  /**
   * Hold a PermissionRequest until it's answered on a card or in the terminal. Returns the decision id,
   * or null when the hook isn't from a live launch (the caller answers it at once with nothing).
   */
  hold(sessionId: string, body: unknown, launch: string | undefined, held: Held): string | null;
  /** The held request closed without a card answer (answered in the terminal, Esc, timeout). */
  decisionClosed(decisionId: string): void;
  /** Answer a pending decision from a card; throws UserError (Gone → 409) when it's already answered. */
  answer(sessionId: string, decisionId: string, a: Answer): SessionView;
  /** Rebuild every session's state from stored events and tmux (boot; never notifies). */
  reconcile(now: number): void;
  /** End non-ended sessions whose tmux session or pane is gone, via a synthetic pane_exit event. */
  checkPanes(): void;
  onChange(fn: (v: SessionView) => void): () => void;
  /** Free the worktree (WIP commit + ignored files set aside); the session ends. */
  pause(id: string): Promise<SessionView>;
  /** Bring a paused or ended session back and continue the same Claude conversation. */
  resume(id: string): Promise<SessionView & { warning?: string }>;
  /** Free the worktree (unless paused) and hide the session; its branch and events stay. */
  archive(id: string): Promise<void>;
  /** Spot Claude's trust dialog on starting sessions' panes (called by the pane watcher). */
  checkTrust(): void;
  briefing(id: string): Briefing & { state: SessionState };
  /** Re-read git facts (one session, or all) and recompute overlap; `silent` seeds overlap without notifying. */
  refreshGit(opts?: { id?: string; silent?: boolean }): Promise<void>;
  /** Save an upload for a session; returns what was saved and the text to paste into its prompt. */
  attach(id: string, name: string, data: Buffer): Promise<Saved & { insert: string }>;
  /** Where the session's attachments live. */
  attachments(id: string): string;
  /** What the Files panel diffs against: the worktree's base, or null (HEAD) in place. */
  diffBase(id: string): string | null;
  /** The repo top of an in-place git session (git paths are relative to it). */
  repoTop(id: string): string | null;
  /** Stop timers (debounced refreshes). */
  close(): void;
};

