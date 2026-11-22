# v0.5 calm: results (2026-10-29, Claude Code 2.1.312, tmux 3.8, Node 26, macOS)

**Verdict: GO.** All 10 criteria met. 294 tests pass; typecheck and `npm run check` are clean; no file over 600
lines. **Day in the life** (8 h, 12 sessions, 87 needs-you moments): 87 interruptions without focus windows,
**25 with them**, and every urgent one still sent at once (`test/unit/day-in-life.test.ts`).

| # | Criterion | Evidence |
|---|---|---|
| 1 | Settings | `src/settings.ts`; unit validation tests; e2e GET/PUT and 400; file 0600 (checked live). Pace panel screenshot `shots/*-pace.png`. |
| 2 | Urgent vs held | `test/unit/attention.test.ts` (fake clock); e2e: a low-risk permission is held, a high-risk one notifies at once, Show now releases. |
| 3 | Quiet hours and budget | Unit: quiet hours across midnight hold everything and summarise ("Held 2 items during quiet hours"); budget holds the rest until it recovers; held items and the quiet count survive a restart (`held.json`). |
| 4 | Batched release | Unit: one notification naming up to 3 sessions; answered needs dropped; "things to look at" for mixed batches. Top bar "N held · Show now" (screenshots). |
| 5 | Stuck | `test/unit/stuck.test.ts` (normalised errors, 15-min window, interrupts ignored); e2e: flagged with the error verbatim, cleared by a success. A running tool is never "silent". |
| 6 | Crashed | e2e: a killed pane → crashed + urgent notification; `/exit` is not a crash; Esc leaves the session idle. Rebuilt after restart. |
| 7 | Soft limit | `test/unit/calm-ui.test.ts` (`wipNote`); shown in the New session dialog. |
| 8 | Park everything | e2e: types only into working sessions; never into a session with a card or a dialog on screen (`test/unit/park.test.ts`, e2e). |
| 9 | Wrap-up / Since you left | `test/unit/wrapup.test.ts`, e2e; async git with timeout, 30 s cache. Today panel screenshot `shots/*-today.png`. |
| 10 | Quality | Opus review (code + security): 5 Important, ~14 Minor, no security issues; fixed in `4173243`, scoped re-review. |
