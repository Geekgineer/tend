# v0.1 walking skeleton: go/no-go criteria (written before the plan)

**Scope (strict):** fleet strip, session list (For you / All), one live terminal per selected session, hook-driven session states, OS notifications. **Nothing else.** No briefings, worktrees, permission cards, context/usage, accounts or focus features: those are v0.2+.

| # | Criterion | Evidence required |
|---|---|---|
| 1 | `npx tend` (run from the repo via `node bin/tend.mjs`) starts one local server on 127.0.0.1:4977 and prints the tokenized URL | Command output |
| 2 | Requests without the token, or with a foreign Origin/Host, are rejected (401/403) | Automated test |
| 3 | "New session" starts `claude` in a tmux session (`tmux -L tend`) in a chosen folder with Tend's `--settings`; it appears in the list within 2 s | E2E test (fake claude) + one real-claude smoke run |
| 4 | States derive from hook events replayed from **sanitised Phase 0 fixtures**: working, needs-you (permission/question/plan), idle, ended. The `SubagentStop`-after-`Stop` and `Notification`-with-`PermissionRequest` quirks don't flip state or double-notify | Unit tests (pure state machine), property test |
| 5 | Selecting a session shows its live terminal (tmux control mode). Keys typed in the browser reach the pane. The rendered screen equals `tmux capture-pane` (0 differing lines) at 2 sizes | Automated fidelity test (headless xterm) |
| 6 | Entering a needs-you state fires exactly one macOS notification per state change | Unit test on the notifier decision + manual-free smoke (osascript stub) |
| 7 | Killing the core and restarting it rebuilds the list from tmux + the event log; sessions keep running | E2E test |
| 8 | Headless-Chrome screenshots of the list + terminal at 1720×1000, dark and light, show no overlap or clipping | Screenshots reviewed |
| 9 | Typecheck, lint (`npm run check`: size, dependency allowlist, `node --check`, no `console.log` in src) and all tests green; no file over 600 lines; no native dependencies | CI-equivalent command output |

**Stop and report if:** criterion 5 fails (terminal fidelity), or criterion 3 can't start real `claude` reliably.
