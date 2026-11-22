# Acceptance scenarios (spec §18) on v1.0

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Two sessions edit the same file → both show `overlap` within 2 s of the second write; neither is blocked. | **Met** | `test/e2e/overlap.test.ts` (both flagged, one notification, nothing blocked). |
| 2 | A high-risk permission arrives while the user types in another session's terminal → no keystroke affects it, a notification fires, Allow needs a two-step click. | **Met** | Cards never type keys (grep test); shortcuts never act on high risk or from the terminal (`test/unit/decision-ui.test.ts`); the server refuses a high-risk allow without `confirm` (`test/e2e/decisions.test.ts`); high risk is urgent and notifies inside a focus window (`test/e2e/calm.test.ts`). |
| 3 | The selected session crashes → `crashed`, scrollback preserved, Resume works. | **Met** | `test/e2e/calm.test.ts` (crashed + urgent notification), tmux `remain-on-exit` keeps the pane, Resume continues the same conversation (`scripts/smoke/real.mjs`: PELICAN remembered). |
| 4 | Tend is killed with a permission pending → Claude falls back to its TUI dialog; after restart the card says "Answer in terminal". | **Met** | Phase 0: with the hook server gone Claude shows its dialog and approves nothing; `test/e2e/restart.test.ts` (the held request is dropped, never answered; after restart: needs-you with no card → "Claude is waiting for you in the terminal"). |
| 5 | An image is pasted → saved outside the repo's tracked files, the path inserted, Claude describes it. | **Met** | `scripts/smoke/media.mjs` (real haiku: "Red", no permission prompt); `test/e2e/media.test.ts` (`.tend/` excluded, `git status` clean, path pasted, nothing sent). |
| 6 | The spec's example (§5) → the card shows Read spec / View commit / Ask for changes / Open PR/MR, and every fact matches git. | **Partial** | The *review* state and its card were not built. What exists: git facts (branch, commits since base, uncommitted) match git (`test/integration/git.test.ts`), the briefing lists what got done with files, the Files panel shows diffs, and Claude's own commit/PR flow runs in the terminal. Parked: a review card with those four actions. |
| 7 | 20 sessions run for 8 hours → no event lost; UI responsive (< 100 ms input latency in the focused terminal). | **Met (compressed)** | `scripts/perf/load.mjs`: 20 sessions, ~10 events/s each (hooks + status), 2 and 6 minute runs: 0 events lost, keystroke round trip p95 ≈ 3 ms, memory levels off (see RESULTS.md). Not run for 8 real hours. |
| 8 | Single-key actions ignored while the terminal has focus, and for 500 ms after switching sessions (and after a new card). | **Met** | `test/unit/decision-ui.test.ts` (`shortcutAllowed`), live browser check in v0.3 (D at 300 ms ignored, at 800 ms denied). |

## v1 scope items not built (spec §16)
- The *review* state and review cards (scenario 6); AI review assist (later anyway).
- A shell tab next to the Claude terminal; xterm search.
- External (non-Tend) session rows (`claude agents --json`, a research preview).
- Opt-in AI summary (`claude -p` over a session's events).
- "Include uncommitted changes" when creating a worktree from a dirty checkout, and the per-project include list
  (`.env*` copied in).
- SHA / branch smart links; markdown/HTML/dev-server previews; the outputs shelf.
