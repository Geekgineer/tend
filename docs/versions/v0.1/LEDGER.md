# SDD ledger — plan: docs/design/plans/2026-10-28-tend-v0.1-walking-skeleton.md
Spec: docs/design/2026-10-27-tend-design.md (+ spike/RESULTS.md overrides). Branch: v0.1 (from main df75138).
Ruling: work on branch `v0.1` in the main checkout instead of a separate worktree — single-repo autonomous build, nothing else uses this checkout — cost if wrong: none (branch is isolated; main untouched).

## Pre-flight scan
| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T8, T11 | authorize(), loadOrCreateToken(), cookie | consistent |
| T2 → T3 | TendEvent, fixtures 021–024 (verified: UPS, PreToolUse AskUserQuestion, PermissionRequest, Notification) | consistent |
| T2 → T6 | fixture names 005/006/007/009/011/023/SessionEnd | consistent |
| T3 → T8 | reduce(), notifyFor(prev,next,id,name) | consistent |
| T4 → T8, T10 | Store methods | consistent |
| T5 → T9 | ControlClient; T9 adds acquire/release/activeClients in same file | consistent |
| T5 → T8 | helpers.ts created T5, extended T8 (startServer) | consistent |
| T6 → T12 | launchArgv(bin,settings,name); T12 adds TEND_CLAUDE_ARGS | Ruling: launchArgv keeps its 3-arg signature and reads TEND_CLAUDE_ARGS from env internally (split on whitespace) — keeps T6 interface stable — cost if wrong: trivial refactor |
| T1 package.json `check` → T12 scripts/check.mjs | script missing until T12 | accepted: `npm run check` only required from T12 |
| T1..T12 self-consistency | tests vs code per task | consistent after plan-review fixes (df75138) |
Task 1: minor (deferred): reuse path doesn't re-chmod token to 0600; invalid TEND_PORT silently falls back; no tests for tendHome/port; caret ranges on xterm deps (lock pins exact); skipLibCheck added
Task 1: complete (commits df75138..15c6bc5, review clean; ⚠️ verified by controller: npm test + typecheck pass)
Task 2: Ruling: accept implementer extra sanitiser rule `-private-tmp-claude-502-[A-Za-z0-9-]*` → `-REPO` — required to meet the plan own forbidden-string test (spec intent: no identifying data) — cost if wrong: none
Task 2: minor (deferred): sanitizer runs side effects on import (no main guard); first rule [^"]* could eat an escaped-quote backslash (latent); PII test checks only 3 strings; events test uses reference equality
Task 2: complete (commits 15c6bc5..02b529d, review clean; controller re-ran npm test)
Task 3: minor (deferred): property test lacks `since` invariants; intent-count invariant weak (as briefed); fixtures replay at constant ts; 'a tool' fallback text when no PreToolUse seen
Task 3: complete (commits 02b529d..cdf9761, review clean; controller re-ran npm test)
Task 4: minor (deferred): close() not idempotent; no busy_timeout; reopen test leaks handle on failure; WAL/index not asserted by tests
Task 4: complete (commits cdf9761..f2bdf51, review clean; controller re-ran npm test)
Task 5: minor (deferred → carry to Task 9): ControlClient has no exit/alive signal and swallows errors; attach/send-keys use prefix match + interpolated session (use =session, defensive id check)
Task 5: minor (deferred): killSocket macOS-only path, tempHome dirs not removed; snapshot non-atomic/utf8 re-encode; argv element ";" hazard; ControlClient tests use fixed sleeps
Task 5: complete (commits f2bdf51..13d47a0, review clean; controller re-ran npm test)
Task 6: minor (deferred): integration test lacks try/finally + JSON.parse guard; fake-claude fetch has no timeout; hook taken from first event only
Task 6: complete (commits 13d47a0..badee9c, review clean; controller verified fixtures exist + npm test)
Task 7: minor (deferred): never-throws path untested; silent stub failure; no osascript timeout
Task 7: complete (commits badee9c..b146619, review clean; controller verified NotifyIntent export + npm test)
Task 8: Ruling: /hook body cap 1 MB (API JSON stays 16 KB) — real hook payloads carry tool_input (e.g. Write file contents); a 16 KB cap would drop needs_you events (spec intent > plan number) — cost if wrong: memory per request bounded at 1 MB, loopback + token only
Task 8: Ruling: accept extra Registry.get(id) and test-helper process.env copy — needed for 202-before-body and claudeBin() env lookup — cost if wrong: trivial
Task 8: minor (deferred): internal errors not logged (hook failures invisible); ingest partial-failure ordering; create() orphan cleanup on failure; relative cwd resolves vs server cwd; SSE no backpressure; 413 drain; close ordering
Task 8: complete (commits b146619..0d22c0a, review clean; ⚠️ checked by controller: newSession chain sets window-size manual, ensureServerOptions no-op without server is fine)
Task 9: Ruling: /term for a registered session whose tmux session is gone must return 404 (not 200-then-end, which makes EventSource reconnect-loop) — carried into Task 10 (it owns dead-session handling) — cost if wrong: small
Task 9: Ruling: UI (Task 11) must open /term first and buffer chunks, then apply snapshot + buffer; and send /keys strictly sequentially — server-side atomic snapshot deferred — cost if wrong: occasional lost output between snapshot and stream
Task 9: minor (deferred): /keys without open stream spawns a client per request (ordering only matters outside the terminal UI); SSE no backpressure; exact-target send-keys test is vacuous; `activeClients() <= 1` should be `=== 1`
Task 9: complete (commits 0d22c0a..ee2cda3, review clean; controller re-ran npm test)
Task 10: minor (deferred): /term 404 test only covers ended+missing combo; boot reconcile not try/caught; listen failure leaks watcher/store; sync tmux probes in watcher; test style nits
Task 10: complete (commits ee2cda3..a535e8b, review clean; controller re-ran npm test)
Task 11: minor (deferred, flag for final review — likely fix before merge): onSession doesn't re-mount terminal after stream drop (live status over dead terminal); ?snap still POSTs /resize to live session; pastes >64KB silently dropped (413 swallowed)
Task 11: minor (deferred): Google Fonts render-blocking third-party stylesheet; screenshot cleanup hardcodes macOS tmux path; 401 sign-in page untested
Task 11: complete (commits a535e8b..19417a2, review clean; controller viewed dark-terminal screenshot + re-ran npm test)
Task 12: Ruling: accept 6 real haiku smoke sessions (plan said one) — needed to diagnose a trust-dialog timing flake; well within the playbook budget of ~50 per version — cost if wrong: a few cents of usage
Task 12: minor (deferred): RESULTS wording on flake diagnosis should say "likely/mitigated n=1"; default port 4977 untested; check.mjs failure paths not under committed tests, no-native-deps not enforced; smoke db handle/socket path nits; onPath accepts executable dirs
Task 12: complete (commits 19417a2..f611c96, review clean; controller re-ran npm test + check)
Final review: With fixes → 8 findings (4 Important + Google Fonts + 3 minors) fixed in one wave (b4c9821..37023ca), scoped re-review: all addressed, no new breakage. Controller live check of the real CLI: start, create session (folder with space), needs_you via fake perm, one notification, UI 200, no-auth 401.
Ruling: merge v0.1 into main locally and tag v0.1.0 (no push) — user asked for fully autonomous local work; merge is local and reversible — cost if wrong: `git reset` on main
