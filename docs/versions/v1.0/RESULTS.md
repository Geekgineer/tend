# v1.0: results (2026-10-29, Claude Code 2.1.312, tmux 3.8, Node 26, macOS)

| # | Criterion | Result |
|---|---|---|
| 1 | Acceptance scenarios | 7 of 8 met, scenario 6 partial (no review card) — see ACCEPTANCE.md. |
| 2 | Conformance on the installed Claude Code | **Self-test on 2.1.312: pass.** Every real-claude smoke on the final code: `smoke-real` (worktree, trust as needs-you, pause → resume remembers PELICAN), `smoke-decisions` (allow, deny, question, terminal answer, plan), `smoke-usage` (context and usage equal Claude's JSON), `smoke-media` (attached PNG described "Red", no prompt) — all PASS. |
| 3 | Packaging from a clean folder | `scripts/smoke/package.mjs`: the tarball ships bin/, dist/, ui/ and the README only; installed into an empty folder, `tend` runs the compiled code from node_modules, serves the page and vendor files, starts a session, and the status line wrapper inside the installed package reports. PASS. |
| 4 | Load | `scripts/perf/load.mjs`, 20 sessions, ~10 events/s each (hooks + status lines): **2 min:** 20,280 hooks, 0 lost, keystroke round trip p95 2.9 ms; **6 min:** 60,140 hooks, 0 lost, p95 3.4 ms (max 12 ms), API p95 1.7 ms; memory 128 → 183 MB, flat after the first minutes (max 187). |
| 5 | Quality | 317 tests pass; typecheck and check clean; final whole-product review (opus): no Critical, 3 Important + 1 borderline, 4 Minor — all fixed (LEDGER.md), re-checked by smoke-usage, smoke-decisions and smoke-package (PASS). |

## Real-claude usage across the whole build
Roughly 70 short haiku sessions for v0.2–v1.0 combined (smoke runs, experiments that settled design questions,
self-tests), each a one- or two-line prompt in a temp repo.
