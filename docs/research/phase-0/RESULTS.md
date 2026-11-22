# Phase 0 results (2026-10-28, Claude Code 2.1.312, tmux 3.8, Node 26, macOS 27 arm64)

**Verdict: GO.** Every stop-the-project risk passed. Two findings make the design simpler and safer than planned.

| # | Question | Result | Evidence |
|---|---|---|---|
| 1 | Browser terminal faithful via tmux control mode? | **GO.** Headless xterm fed by the control-mode stream matched `tmux capture-pane` on **0 of 42 lines differing**: after the snapshot, during a streamed permission dialog, and after keys typed through the bridge (Esc + text). A real-browser screenshot shows colours, bold and the dialog correctly. No native pty module needed. | `verify-stream.mjs` output, `shots/bridge.png` |
| 2 | HTTP hooks via `--settings`? | **GO.** All events arrive from a session started with `--settings <file>`; nothing written into the repo. **Note:** `SessionStart` was **not** delivered to HTTP hooks; `SessionEnd` **was** (seen when a session was killed in Phase 0b). Lifecycle = tmux pane state + first event + SessionEnd. | `fixtures/` |
| 3 | PermissionRequest held open | **GO, and better than expected.** Claude shows its own dialog *while* the hook is pending. A hook `allow` resolves it and **dismisses the dialog** ("Allowed by PermissionRequest hook"). If the user answers in the terminal instead, **Claude closes the held HTTP request**, so Tend sees the close and resolves the card. First answer wins, no race. | `server.log` ("held request closed by client") |
| 4 | Hook server down | **GO.** Claude shows its normal dialog and approves nothing by itself. | screen capture during test |
| 5 | Questions | **GO, upgraded.** `AskUserQuestion` arrives as **PermissionRequest** (plus PreToolUse) with the full `questions` payload. Answering with `allow` + `updatedInput: {questions, answers: {"<question>": "<label>"}}` answers the question officially ("User answered Claude's questions → Blue"). **Permissions and single-select questions need no keystrokes** (multi-select and free-text answers untested). | `fixtures/*PreToolUse*` with `AskUserQuestion`, screen capture |
| 6 | Task events | **NO** in this session: no task tool was available (`TodoWrite` not found via ToolSearch). "Step n of m" is cut from v0.1; revisit when task events appear. | screen capture |
| 7 | Status line fields | **GO.** `context_window` (used %, size 1M, tokens), `rate_limits.five_hour/seven_day` (+ `resets_at`), `prompt_cache` (warm, ttl, expires_at, hit_ratio, recache_tokens_if_cold), cost, session_name all present. | `fixtures/*statusline*` |
| 8 | Image by path | **GO.** An image at `.tend/attachments/shot.png` (excluded via `.git/info/exclude`) was described with no permission prompt. | screen capture |
| + | Workspace trust dialog | A new folder triggers "Do you trust this folder?". **Trusting a parent covers its children**, so Tend asks once for `~/.tend/worktrees`. | trust test |
| + | User's default permission mode is `auto` | Tend must respect the user's mode; the spike forced `--permission-mode default` to provoke prompts. | `~/.claude/settings.json` |

## Design changes carried into v0.1
1. **Terminal transport = tmux control mode** (`tmux -L tend -C attach`), snapshot via `capture-pane -e` + cursor position, keys via `send-keys -H`. No native dependencies.
2. **Permissions and questions both go through the PermissionRequest hook.** Remove the keystroke path from design §11 and the "undocumented UI" row from §20.
3. **Single owner is natural:** card answer → hook response; terminal answer → Claude closes the request → card resolves on `close`.
4. **Lifecycle** from tmux pane state, first event and status line, not SessionStart.
5. **No step counts** until task events are observed.
6. **One-time trust** of `~/.tend/worktrees`.
7. **Fixtures:** 102 real payloads in `fixtures/` (PermissionRequest ×11, PreToolUse ×14, Stop ×6, status line ×36, …) become the replay fixtures for tests.

## Spike bugs found (spike code only, not the approach)
- SSE headers weren't flushed until the first event (fixed with an initial `:ok` comment).
- Control-mode bytes were double-encoded as UTF-8 (fixed by pushing raw bytes).

## Phase 0b (gaps found by review)
| Question | Result |
|---|---|
| Plan approval (`ExitPlanMode`) | Arrives as **PermissionRequest** with `tool_input.plan` + `planFilePath`. A plain `allow` does **not** close the plan dialog. `allow` + `updatedInput: <original tool_input>` **approves the plan** and Claude starts implementing, in manual-approve mode. Picking "approve and use auto mode" from a hook is **unverified**, so it's a v0.3 task (try `updatedPermissions` setMode). |
| User's real mode `auto` | Safe actions (Write in repo, `ls`, `rm` of a repo file) raised **no PermissionRequest**, so the inbox stays quiet. Escalation behaviour for risky actions in auto mode is untested (v0.3). |
| `--settings` precedence | **Hooks merge:** the project's own hook fired alongside Tend's. **statusLine: `--settings` wins** over the project's. So Tend's status-line wrapper must resolve and run the user's effective statusLine itself (local > project > user). |
| Resize | With `window-size manual` and browser-driven `resize-window`, the stream plus a re-snapshot match tmux at 120×35 (**0 of 35 lines differ**). Second-client protection is **inconclusive**: the test client had no tty. A v0.1 test covers it. |
| IDE integration | When VS Code is connected, Claude opened the diff in VS Code, and a held PermissionRequest was **closed by the client** during that flow. Treat close-without-answer as "answered elsewhere" and resolve the card (v0.3 test). |

## Carried into v0.1 as tasks
- **Sanitise fixtures:** replace home paths, session ids and transcript paths with placeholders.
- **State-machine quirks:** `SubagentStop` follows every `Stop` (no subagent), and `Notification` accompanies every `PermissionRequest`. Neither may flip state or double-notify.
- **Held-request endings:** answered in the terminal, Esc in the terminal, Tend answering after close (destroyed response → no-op), closed by an IDE.
