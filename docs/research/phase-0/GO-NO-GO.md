# Phase 0: go/no-go criteria (written before running anything)

| # | Question | GO if | Consequence if NO |
|---|---|---|---|
| 1 | Does tmux control mode stream the Claude Code TUI faithfully into xterm.js? | A headless screenshot of the browser terminal shows the same screen as `tmux capture-pane` (prompt box, colours, a permission dialog) | Try a native pty bridge (`node-pty`). If that fails too, **STOP the project** and report. |
| 2 | Are HTTP hooks loaded via `--settings` and merged with the user's settings? | Events arrive at the local server from a session started with `--settings <file>`; the user's own settings still apply | Fall back to a worktree `.claude/settings.local.json` |
| 3 | PermissionRequest held open: what does the TUI show, and does a hook answer resolve it? | Hook `allow` resolves the request and the session continues; behaviour of the TUI dialog during the hold is recorded | Permission cards become "focus the terminal" (shrink) |
| 4 | Hook server gone or timed out: what happens? | Claude falls back to its normal dialog, nothing is auto-approved | Design must change before v0.3 |
| 5 | AskUserQuestion / ExitPlanMode visible to hooks? | PreToolUse fires with these tool names and the question payload | Question cards focus the terminal (shrink) |
| 6 | Task events (TaskCreated/TaskCompleted) in interactive sessions? | They fire for Claude's task list | "Step n of m" is cut from v0.1 |
| 7 | Status line JSON: context_window, rate_limits, prompt_cache present? | Fields present on this account and version | Context/usage features degrade or are cut |
| 8 | Image by path read without a permission prompt? | Claude describes an image at a relative path in the cwd without asking | Use `--add-dir` or attach via another route |

**Recorded fixtures** (every real payload) go to `spike/fixtures/` and become the test fixtures for v0.1+.
Budget: at most ~10 short real sessions with `--model haiku`.
