# v0.3 decisions: go/no-go criteria (written before the plan)

**Scope (strict):** answer Claude's permission requests, questions and plan approvals from Tend, through the
`PermissionRequest` hook that Phase 0 verified. A rule-based risk label on every permission. Typing safety.
**Not in scope:** context/usage/accounts (v0.4), focus windows and quiet hours (v0.5), attachments, files/diff panel,
"stuck"/"review" states, multi-select or free-text question answers (those cards say "Answer in the terminal").

**Facts verified before writing this (Phase 0, Claude Code 2.1.312):**
- Claude shows its own dialog while a `PermissionRequest` http hook is held; a hook `allow` dismisses it.
- If the user answers in the terminal, Claude closes the held request: first answer wins.
- `AskUserQuestion` arrives as `PermissionRequest`; `allow` + `updatedInput {questions, answers: {"<question>": "<label>"}}` answers it.
- `ExitPlanMode` arrives as `PermissionRequest`; `allow` + `updatedInput: <original tool_input>` approves the plan.
- With the hook server gone, Claude shows its normal dialog and approves nothing by itself.

| # | Criterion | Evidence required |
|---|---|---|
| 1 | **Held, not auto-answered.** A `PermissionRequest` from a live launch is held open until the user answers; the hook's timeout in Tend's settings is 3600 s (others stay 10 s). Unknown sessions and stale launches still get an immediate empty 200 (Claude falls back to its dialog). Tend never answers on its own. | E2E with fake claude; settings unit test |
| 2 | **Cards.** `SessionView.decisions` lists pending decisions (id, kind permission/question/plan, tool, the input fields a person needs: command, description, file path, questions/options, plan text, the folder), oldest first. The detail view shows the first one as a card above the briefing, built with textContent only. | Unit + XSS test, screenshots |
| 3 | **Answers.** `POST /api/sessions/:id/decisions/:did` with `allow` / `deny` (optional message) / `always` (echoes Claude's own `permission_suggestions` as `updatedPermissions`) / `answers` (question) / `approve` (plan). The held request gets the exact verified JSON. Answering a decision that's gone (answered in the terminal, Tend restarted, session ended) returns 409 "Already answered" and sends nothing. | E2E per kind; 409 test |
| 4 | **First answer wins.** When Claude closes the held request, the decision disappears and the card resolves; a later card answer is a 409 no-op. A request closed without an answer (terminal, Esc, IDE) never turns into an allow. *(Amended during the build: real 2.1.312 keeps the request open after an answer in the terminal, so the matching PostToolUse, a Stop or a new prompt settles the card with an empty answer.)* | E2E: fake claude aborts its request, and leaves it open |
| 5 | **20 scripted permissions, zero mis-approvals.** A harness raises 20 permission requests across 4 sessions in interleaved order and answers each through the API; every fake claude receives exactly the answer meant for its own request (allow vs deny checked per request). | E2E harness output |
| 6 | **Risk rules.** Every permission gets `risk: {level: high|medium|low, rule}` from readable rules: recursive deletes, force push, `reset --hard`, `DROP/TRUNCATE`, `DELETE` without `WHERE`, `sudo`, `curl … | sh`, destructive cloud verbs, writes outside the session folder → high; package installs, migrations, git push, network fetches → medium; else low. Extra rules can be added in `~/.tend/risk-rules.json`. | Unit table test (≥ 30 commands) |
| 7 | **High risk is never one click.** High-risk cards need a two-step Allow (click, then "Confirm allow" within 5 s) and never offer "Always allow"; the server refuses `always` on a high-risk decision. | UI unit test + API test |
| 8 | **Typing safety.** Card keyboard shortcuts (A allow, D deny, 1–9 pick an option) work only when no text input or terminal has focus, never for high risk, and are ignored for 500 ms after the selected session changes. Card answers never send keystrokes to tmux. | UI unit tests; grep test that decisions code never calls send-keys |
| 9 | **Restart and crash.** After Tend restarts, a session still in needs-you shows "Answer in the terminal" (no pending decision). A session that ends drops its decisions. | E2E restart test |
| 10 | **Real smoke (haiku, temp repo, `--permission-mode default`).** A real permission answered from Tend runs the tool; a deny stops it; a question answered from Tend is accepted; a plan approved from Tend starts implementing; answering in the terminal resolves the card. | Script output |
| 11 | **Quality and security.** check/typecheck/tests green; no file over 600 lines; new routes need the token and validate both ids; whole-branch review and security review have no open Critical/Important findings. | Command output + review reports |

**Stop and report if:** a real hook answer no longer dismisses Claude's dialog, or a closed request could ever be read as an allow.
