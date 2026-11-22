# v0.3 decisions: ledger

Execution: native (implemented in the main session), then an opus whole-branch review and an opus security
review, one fix wave, real-claude smoke. Ruling: native instead of subagent-per-task, because the broker,
registry, server and UI pieces share one new interface and the plan was small; cost if wrong: less
independent review per task, covered by the two final reviews.

## Rulings
- **Answers go through the PermissionRequest hook only; no keystrokes.** Phase 0 verified permissions,
  single-select questions and plan approval this way. Multi-select questions are terminal-only cards.
  Cost if wrong: none for safety; a few cards say "answer in the terminal".
- **"Always allow" echoes Claude's own `permission_suggestions`** (for example "accept edits for this
  session") instead of inventing rules. Never on high risk; the server refuses it too.
  Cost if wrong: fewer "always" options than the spec's exact-pattern rules (later version).
- **2.1.312 does not close a held request after an answer in the terminal** (Phase 0 saw it close). Found by
  the real smoke. Tend settles the card when the matching PostToolUse/PostToolUseFailure, a Stop or a new
  prompt arrives, replying `{}` (no decision). Claude can't end a turn while a permission is pending, so a
  Stop proves nothing in that turn is still waiting. Cost if wrong: a stale card until the turn ends.
- **Edits outside the session folder are high risk.** The folder is the worktree, or the repo top for an
  in-place git session. The fake fixture writes to `/REPO/...`, so in tests that card is high risk.
- **Keyboard:** A = allow, D = deny, 1–9 = option; none on high-risk cards; ignored inside inputs, the
  terminal and dialogs, and for 500 ms after switching sessions. The terminal keeps focus after mounting
  (v0.1 behaviour), so shortcuts work after clicking outside it.
- **Plan "Keep planning"** = deny with a message (default "Keep planning."). Unverified on real Claude;
  the approve path is verified.
- **Notifications** stay as in v0.2 (one per state change). Risk-aware batching is v0.5 (focus windows).

## Parked
- Exact-pattern "Always allow" rules saved to Claude's settings (spec §11) — needs a verified rule format.
- Approving a plan "with auto mode" from a hook (Phase 0b: unverified).
- Prompt-cache-expiry ordering of decisions (needs v0.4 status line data).

## Reviews and fixes (one wave, `b07e33f`)
- **H1 (security):** "always" passed Claude's raw suggestions (a `Bash(git push:*)` prefix saved to local settings
  would later allow `git push --force` with no card). Now only session-scoped accept-edits or exact rules, shown on
  the button.
- **M3 (security):** the hook token sits in every settings file. Hooks now use `~/.tend/hook-token`, accepted only on
  `/hook`; the UI token is in no session file. Sessions started before v0.3 keep working (their hooks still send
  the UI token, which `/hook` also accepts). High-risk allow also needs `confirm: true` on the server.
- **M1/M2 (security) + review risk list:** classifier evasions closed; commands over 8 KB are high and unscanned
  (the regexes were quadratic on 1 MB input).
- **Review 1, 4, 5:** question/plan settle by tool name; a held card keeps needs-you; answers pinned to the drawn card
  and the guard resets on a new card.
- **Review 2 (late allow after No/Esc):** tested on real Claude: both close the request; nothing runs.
- Minors: closed-before-held, drop replies `{}`, hold order (no "waiting in the terminal" flash), 64-bit ids, 20 held
  per session, full question text kept for answer keys, rules cached by mtime.
