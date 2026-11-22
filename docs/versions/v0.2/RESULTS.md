# v0.2 memory: results (2026-10-28, Claude Code 2.1.312, git, tmux 3.8, Node 26, macOS)

**Verdict: GO.** All 11 go/no-go criteria are met. The suite runs 211 tests, all passing; typecheck and `npm run check` are clean; the largest source file is under 450 lines. The real-Claude smoke run (haiku) passes.

| # | Criterion | Evidence |
|---|---|---|
| 1 | Briefing | `test/unit/briefing.test.ts` replays the Phase 0 fixtures and gets goal, 13 instructions, 7 done entries with per-turn files, and `files` = hello/two/a/b/c/auto. A subfolder launch gives repo-relative paths (fix wave I1). The XSS test in `ui.test.ts` checks that briefing DOM is built with `textContent` only. |
| 2 | Worktree on create | `test/integration/workspace.test.ts` and `test/e2e/sessions.test.ts` cover: branch `tend/<slug>-<id>`, base SHA pinned, subfolder preserved (created if untracked), the dirty and no-commits warnings, in-place fallback, two same-name sessions on distinct branches, and git failure → 400. |
| 3 | Git facts | `test/integration/git.test.ts`: 200 fact reads alongside 50 commits gave **0 lock errors**, and the test fails if `--no-optional-locks` is removed. Also covered: rename parsing, `.tend` excluded, `changed` capped at 500, and Tend's git calls run no repo hooks or fsmonitor. |
| 4 | Overlap | `test/e2e/overlap.test.ts`: both sessions are flagged within 2 s, with exactly one notification per pair. In-place sessions are excluded. A restart sends no notifications, and a transient git error doesn't re-notify. |
| 5 | Pause / resume | `test/e2e/lifecycle*.test.ts`. A dirty tree plus an ignored `.env` and `node_modules` come back byte-for-byte; a clean tree makes no commit; a real commit is never reset; a locked or still-written worktree aborts with nothing lost; a detached or switched HEAD is refused (fix wave C1); a deleted branch gives a 400; resume is idempotent; a stale-nonce hook is dropped. |
| 6 | Resume ended | In-place and worktree sessions resume with `--resume=<uuid>`, or `--session-id=<uuid>` if Claude never wrote a transcript. Tend never uses `--continue`. The **real smoke** confirmed the resumed conversation remembered "PELICAN". |
| 7 | Archive | Archive removes the worktree, keeps the branch and events, and hides the session. It works when the worktree was deleted by hand (git forgets it). |
| 8 | Restart | `test/e2e/restart.test.ts`: facts, overlap, paused, archived, briefings and a resumed session all survive a restart with zero notifications. |
| 9 | UI | There are 20 screenshots in `shots/`: briefing, overlap, paused, new-session and trust, at 1720×1000 and 1280×800, dark and light. The controller reviewed them; nothing is clipped, and amber is used only for attention. |
| 10 | Quality and security | Each task had its own review. The final whole-branch review (opus) found 1 Critical (C1) and 2 Important; the security review (opus) found 0 Critical/High, 1 Medium and 4 Low. All were fixed in one wave with tests and then confirmed by a scoped re-review. |
| 11 | Trust dialog | The trust dialog is read from the pane (matcher checked against a captured real 2.1.312 dialog) and becomes needs-you/trust with one notification. **Real smoke:** the first worktree session in a repo asks; a second one doesn't, because Claude stores trust per repo. Tend never presses keys in the dialog. |

## What changed against the plan (rulings in LEDGER.md)
- **The one-time "trust tend's worktree folder" setup was removed.** Real Claude stores trust under the main repo path, so it did nothing. The trust-as-needs-you behaviour stays.
- **Resume picks `--resume` only when Claude's transcript file exists, and `--session-id` otherwise.** Real Claude rejects both flags in the wrong case.
- **Pause sets gitignored files aside before removing the worktree.** Verified fact: `git worktree remove` silently deletes ignored files.

## Real-Claude usage
About 14 short haiku sessions across verification and smoke runs, within the budget of 50.
