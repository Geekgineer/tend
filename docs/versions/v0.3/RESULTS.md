# v0.3 decisions: results (2026-10-29, Claude Code 2.1.312, tmux 3.8, Node 26, macOS)

**Verdict: GO.** All 11 criteria met. 248 tests pass; typecheck and `npm run check` are clean; no file over 600
lines. The real-claude smoke (`scripts/smoke/decisions.mjs`, haiku) passes on the final code.

| # | Criterion | Evidence |
|---|---|---|
| 1 | Held, not auto-answered | `test/e2e/sessions.test.ts` (a PermissionRequest stays open until a card answers it), `test/unit/claude-launch.test.ts` (3600 s for PermissionRequest, 10 s for the rest). Unknown sessions and stale launches still get `{}` at once. |
| 2 | Cards | `SessionView.decisions` (display fields only). `test/unit/decision-ui.test.ts`: every card kind renders hostile text as text (the fake DOM throws on innerHTML). Screenshots: `shots/*-permission.png`, `*-high-risk.png`, `*-question.png`, `*-plan.png`. |
| 3 | Answers | `test/e2e/decisions.test.ts`: allow, deny with a note, question answers, plan approve each reach the fake claude as the exact Phase 0 JSON; a gone request is 409 and sends nothing; bad ids 404; bad bodies 400. |
| 4 | First answer wins | Closed request → card resolves, late answer 409 (e2e). **Real 2.1.312:** "Yes" in Claude's dialog leaves the request open → the matching PostToolUse settles the card with `{}`; "No" and Esc close it (verified: late card allow → 409, nothing ran). A settled or closed request is never an allow. |
| 5 | 20 permissions, zero mis-approvals | e2e: 20 interleaved requests over 4 sessions answered in reverse order; every fake claude got exactly its own allow/deny. |
| 6 | Risk rules | `test/unit/risk.test.ts`: 64 commands (incl. evasions from the reviews: `rm -f -r`, `git -C … push --force`, `bash <(curl …)`, `sudo` after a newline), long commands, `.git/` and `.claude/` edits, `~` and symlinked paths. User rules in `~/.tend/risk-rules.json`. |
| 7 | High risk never one click | UI: Allow… → Confirm allow within 5 s, no shortcut, no Always (unit test). Server: `allow` without `confirm: true` → 400; `always` → 400 (e2e). |
| 8 | Typing safety | Shortcuts off inside the terminal/inputs/dialogs, on high risk, and for 500 ms after a switch **or a new card** (unit test + live browser check: D at 300 ms ignored, at 800 ms denied). Answers are pinned to the drawn card. A grep test proves decisions code never sends keys. |
| 9 | Restart and crash | `test/e2e/restart.test.ts`: the held request is dropped (not answered) on the way down; after restart the session is needs-you with no card ("answer in the terminal"). A session that ends drops its cards. |
| 10 | Real smoke | allow ran `mkdir`; deny wrote nothing; the question answer "Blue" was used; a terminal answer resolved the card and a late card answer was 409; an approved plan wrote `plan.txt`. |
| 11 | Quality and security | Opus whole-branch review (5 Important, 4 Minor) and opus security review (1 High, 3 Medium, 4 Low) — all fixed in one wave (`b07e33f`), then a scoped re-review. |

## What changed against the plan (rulings in LEDGER.md)
- 2.1.312 keeps a held request open after "Yes" in its dialog → settle on the following hooks.
- "Always allow" only for session-scoped accept-edits or exact rules; wider suggestions stay in Claude's dialog.
- Hooks get their own token, so code that reads a session's settings file can't answer cards.

## Real-claude usage
About 10 short haiku sessions (4 smoke runs, 2 late-answer experiments, 3 SessionStart checks, 1 pre-trust check).
