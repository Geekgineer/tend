# v0.5 calm: go/no-go criteria (written before the plan)

**Scope (strict):** spec §22 (focus and sustainable pace) and the `stuck` / `crashed` states from §9–§10.
Focus windows, quiet hours, an interruption budget, a soft limit on parallel work, "Park everything", a daily
wrap-up, and "Since you left". **Not in scope:** AI summaries, files/diff panel, attachments, palette.

| # | Criterion | Evidence required |
|---|---|---|
| 1 | **Settings.** `~/.tend/settings.json` (0600) with defaults: focus windows on, 25 min; quiet hours off (22:00–08:00); at most 6 interruptions per hour; soft limit 8 active sessions. `GET/PUT /api/settings` (UI token) validates every field; a bad file falls back to defaults. A settings panel in the UI edits them. | Unit + e2e |
| 2 | **Urgent vs held.** Urgent = high-risk permission, stuck, crashed: notified at once (unless quiet hours or the budget hold them). Everything else (other permissions, questions, plans, trust, overlap, pacing) is held during a focus window and released together every N minutes, or at once with "Show now". With focus windows off, everything notifies at once (v0.4 behaviour). The inbox always shows everything; only notifications are held. | Unit tests with a fake clock |
| 3 | **Quiet hours and budget.** During quiet hours nothing notifies (urgent included); held items are released when quiet hours end, as one notification ("Held 6 items during quiet hours"). Over the hourly budget, further notifications are held until the next window. | Unit tests |
| 4 | **Batched release.** A release sends one notification naming up to 3 sessions ("3 sessions need you: api, deploy, docs"), skips items already answered, and the top bar shows "N held · Show now" with the next release time. | Unit + e2e |
| 5 | **Stuck.** A session is flagged stuck after ≥ 3 `PostToolUseFailure` events with the same tool and normalised error within 15 min, or no event for 10 min while working. The flag shows the repeated error verbatim (no "likely cause"), puts the session in *For you → Problems*, and clears on the next successful tool use, Stop or prompt. | Unit + e2e (fake clock) |
| 6 | **Crashed.** A pane that dies without `SessionEnd` (not by Pause/Archive) marks the session ended + crashed: urgent notification, "Session ended unexpectedly" with Resume. A normal `/exit` is not a crash. | E2E |
| 7 | **Soft limit.** Opening New session with ≥ limit active sessions shows a gentle note ("You have 9 sessions going; your limit is 8"). Nothing is blocked. | UI unit test |
| 8 | **Park everything.** One confirmed action types a short "finish your current step and stop" message into every *working* session (only working, only on confirm), and says how many it asked. | E2E with fake claude |
| 9 | **Wrap-up and Since you left.** `GET /api/wrapup?since=` returns, from the event log: decisions made, sessions finished, sessions started, interruptions sent and held, time spent waiting on you, commits on session branches. The UI shows a "Today" panel, and a one-line "Since you left" notice when the tab comes back after ≥ 5 min away. | Unit + e2e |
| 10 | **Quality.** check/typecheck/tests green; no file over 600 lines; review with no open Critical/Important; screenshots of the settings panel, held indicator, wrap-up, stuck and crashed. | Command output + review |
