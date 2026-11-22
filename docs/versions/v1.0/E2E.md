# Full end-to-end pass (2026-10-29, after v1.0)

| Layer | What | Result |
|---|---|---|
| Browser journey | `scripts/probe/e2e-browser.mjs`: real headless Chrome, real server, fake Claude. 19 checks: sign-in, New session (worktree + in place), ready state, typing reaches Claude, briefing, permission / high-risk (confirm, note) / question / plan cards, keyboard deny with the 500 ms guard, usage pill + popover + context + ring, paste attachment (path at the prompt, not sent, excluded from git), Files panel diff, switching, ⌘⇧K palette, stuck under Problems, held notification + Show now, Pace save + Today, Pause → Resume keeps work, crash flagged, Archive, no page errors | **19/19, three runs in a row** |
| Automated suite | `npm test` (unit, integration, e2e with fake Claude) | **318/318** |
| Packaging | `scripts/smoke/package.mjs` | PASS |
| Load | `scripts/perf/load.mjs`, 20 sessions, 2 min: 19,460 hooks, 0 lost, keys p95 3.8 ms, memory flat ~181 MB | PASS |
| Real Claude (haiku) | `smoke-real`, `smoke-decisions`, `smoke-usage`, `smoke-media`, `selftest` | all PASS |

## Bug found by the browser journey (fixed)
**Resume failed after Pause when the attachment strip was visible.** The strip lists the session's attachments;
the v1.0 symlink check created the attachments folder while listing, which recreated part of the paused session's
removed worktree, so `git worktree add` refused on Resume ("Could not create the worktree"). Listing and serving
no longer create folders (only an upload does). Regression test in `test/e2e/media.test.ts`. The per-route tests
missed it because they never listed attachments of a paused session.
