# SDD ledger — plan: docs/design/plans/2026-10-28-tend-v0.2-memory.md

Spec: docs/design/2026-10-27-tend-design.md · Acceptance: docs/versions/v0.2/GO-NO-GO.md · Branch: v0.2 (main checkout, same as v0.1 ruling)
Base before Task 1: see git log (2d1563f sanitiser fix + docs commit)

## Pre-execution rulings
- Ruling: Tend manages its own worktrees in $TEND_HOME/worktrees/<id>, not `claude --worktree` — needs a fixed path for --resume, a pinned base and pause — cost if wrong: re-plumb create() onto the native flag later.
- Ruling: Claude's session id is chosen by Tend (`--session-id <uuid>`) — verified with real haiku: `--resume` restores it — cost: none known.
- Ruling: resume uses `--resume U` only if `<CLAUDE_CONFIG_DIR|~/.claude>/projects/*/U.jsonl` exists, else `--session-id U` — real claude rejects `--session-id` for an existing transcript ("already in use") and `--resume` for a missing one ("No conversation found") — cost: a resume that fails at once if Claude moves transcripts.
- Ruling: pause moves gitignored entries (`git ls-files --others --ignored --exclude-standard --directory`) to $TEND_HOME/paused/<id>/ by rename, restores them on resume; a failed rename aborts the pause — verified `git worktree remove` (no --force) silently deletes ignored files like .env — cost: a large node_modules move if TEND_HOME is on another filesystem (then pause aborts, nothing lost).
- Ruling: WIP commit uses `--no-verify -c commit.gpgsign=false` on the tend/ branch only — a background pinentry or a failing pre-commit hook would otherwise hang or block pause — cost: an unsigned, unhooked WIP commit that resume undoes anyway.
- Ruling: if worktree removal fails after the WIP commit, pause runs restoreWip before rethrowing — no committed WIP is left behind — cost: none.
- Ruling: git facts = branch, upstream ahead/behind, uncommitted, commits since base, changed files (GO-NO-GO row 3 reworded) — "behind base" is always 0 for a pinned base — cost: none.
- Ruling: overlap sends one notification per newly overlapping pair (not one per side).
- Ruling: Claude's trust dialog is detected from the pane (`/trust this folder/i`) for starting sessions and becomes needs_you `trust` with one notification; plus a one-time "trust tend's worktree folder" setup session so worktree sessions skip the dialog. Never auto-accepted, never written to ~/.claude.json — without it, each worktree session sits silently at the dialog (no hook fires before trust) — cost: text detection degrades to no detection if Claude changes the wording.
- Ruling: fixtures sanitiser keeps repo-relative tails (/REPO/hello.txt) — committed 2d1563f.
- Ruling (plan review, all 12 findings accepted): instructions count 13; realpath home + briefing root; resume only when paused or pane gone; per-launch nonce header drops stale hooks; ignored files stashed; restoreWip on remove failure; resume idempotent + endedAt cleared before `resumed`; create order worktree→row→tmux with rollback archiving the row; archived?: true on SessionView; commonDir stored in Workspace; extra GO-NO-GO tests; WIP commit sets -c user.name=Tend; resume picks --resume iff transcript exists; claudeId follows /clear.
- Ruling: added Task 7 (trust dialog needs-you + one-time worktree trust); UI → Task 8, evidence → Task 9.

## Pre-flight conflict scan
| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1→T4/T5 | Workspace, launchArgv(…,{id,resume}), buildSettings launch | consistent |
| T2→T4/T5/T6 | repoInfo/addWorktree/wipCommit/ignoredEntries/worktreeOn/facts | consistent; T5 uses worktreeOn for idempotence |
| T3→T5 | buildBriefing(events, root) | root = launchCwdOf; realpath handled in T3 |
| T4→T5 | launchCwdOf, hasTranscript, fake-claude transcript + errors | consistent |
| T5→T6 | pause/resume/archive call refreshGit (T6 adds it) | T5 lands before refreshGit exists: T6 adds the calls — ruled OK |
| T6→T8, T7→T8 | git/overlap/paused/archived/trust fields, /api/setup | consistent |
| Each task self-consistency | tests vs code steps | T1 trust events need Need 'trust' in state.ts — included; T7 uses watchIntervalMs (exists in startServer) |
- Task 1 dispatched: BASE 6499f09, implementer sonnet
- Task 1: complete — 939c210 — review Approved (sonnet). Parked minors: extra getSession per hook (cache later), unguarded JSON.parse(workspace), updateSession ignores unknown keys silently.
- Task 2 dispatched: BASE 939c210, implementer sonnet
- Task 2 review: Needs fixes (.tend in uncommitted). Fix round 1 sent to implementer with: ignoredEntries .tend predicate, --no-renames, -uall (Ruling: list untracked files so overlap compares files, not dirs — cost: slower status on huge non-ignored untracked trees), base sha guard, dirty-remove refusal test.
- Task 2: complete — ccfb25c, 0efd339 — re-review inline by controller: all 6 addressed. Note: facts() base must be a sha (callers pass workspace.base). Parked minor: none.
- Task 3 dispatched: BASE 0efd339, implementer sonnet
- Task 3: complete — 89bdd9d — reviewed inline by controller (pure 80-line module): spec compliant, Approved.
- Task 4 dispatched: BASE 89bdd9d, implementer sonnet
- Task 4 implemented b0df2da (DONE_WITH_CONCERNS: no RED run; git error in prepareWorkspace → 500). Ruling: wrap prepareWorkspace git failures as UserError('Could not create the worktree: <msg>') — a 500 hides a user-fixable cause — cost: none.
- Task 4 review (opus): Needs fixes — git error 500, missing launch subdir → claude in $HOME (reviewer verified tmux fallback), CLAUDE_CONFIG_DIR not isolated in tests. Fix round 1 sent.
- Task 4: complete — b0df2da, 90eeb5b — fix round 1 checked inline by controller: all Important addressed (UserError 400, launch subdir mkdir, CLAUDE_CONFIG_DIR temp in helpers). Parked: newId store-only test (needs crypto mock).
- Task 5 dispatched: BASE 90eeb5b, implementer opus
- Task 5 implemented 9bd67fb (DONE_WITH_CONCERNS). Rulings: per-session op queue accepted (prevents concurrent pause/resume); WIP-commit failure must be UserError('Could not save work in progress: <msg>') 400; kill-and-wait timeout must abort with UserError('The session did not stop. Try again.') before any git step — git on a live session's worktree is unsafe; stash clash leaving files in <home>/paused/<id> accepted as known limitation if the next-pause error names that folder; re-add failure reusing "Could not create the worktree" accepted.
- Task 5 review (opus): Needs fixes — rulings (a) WIP 500 and (b) kill-timeout continues (data-loss path) unmet; plus stuck-resume after crash. Fix round 1 sent with minors 4-7. Accepted: pre-pause staging is not preserved (documented in TRY-IT).
- Task 5: complete — 9bd67fb, 60eb4ec — fix round 1 verified inline (kill-timeout abort before git; WIP UserError). Accepted: per-session serial queue; re-add failure copy; archive leaves WIP on branch.
- Task 6 dispatched: BASE 60eb4ec, implementer sonnet
- Task 6 implemented d68049e (DONE_WITH_CONCERNS: no RED; pair body may list files shared with a third session). Ruling: pair notification body must use the intersection of the two sessions' own changed sets (git facts), not Overlap.files.
- Task 6: complete — d68049e — review Approved (sonnet). Parked for final fix wave: overlap ruling unit test (a,b,c), cache prune for removed ids, keep last facts on transient rejection (avoid re-notify), schedule uses this.refresh, test helper duplication.
- Task 7 dispatched: BASE d68049e, implementer sonnet
- Task 7 implemented 915dbcf; controller inline review: Needs fixes — 'No, exit' produces false trust marker; setupId memory-only (lost on restart). Fix round 1 sent.
- Task 7: complete — 915dbcf, 0c22779, f290644 (controller: SessionEnd never counts as trust) — reviewed inline.
- Task 8 dispatched: BASE f290644, implementer opus
- Real smoke (haiku) PASS ×2: worktree session, trust surfaced as needs_you/trust, pause, resume, resumed conversation remembered PELICAN. ~9 real sessions used in v0.2 so far.
- Ruling: REMOVE the one-time worktree-folder trust setup (trust.ts setup/marker, /api/setup routes, UI banner). Real-claude evidence: Claude stores trust under the main repo path (~/.claude.json projects key = repo root) even when accepted inside a worktree; trusting <home>/worktrees does not cover worktrees (smoke FAIL), while a second worktree of an already-trusted repo shows no dialog (smoke PASS). Phase 0's "parent covers children" applies to plain folders, not git worktrees. Trust detection as needs_you stays. Cost if wrong: none — the feature was useless.
- Task 8: implemented 8e38522 (opus; trust banner dropped mid-task per ruling). Visual review via Task 9 screenshots (UI implementer resumed to produce + self-check shots).
- Controller: 96be120 removed trust setup server-side (trust.ts → createTrustCheck only; /api/setup routes and 3 setup tests removed). 180/180 green.
- Task 9 in progress: smoke-real PASS (c14c61c); screenshots dispatched to the Task 8 implementer.
- Task 8: complete — 8e38522, e2e7009 (screenshots + UI polish) — controller visual review of 3 key PNGs: calm, no clipping.
- Security review (opus): no Critical/High. M1 claudeId unvalidated → argv/fs; L1 ignored .tend deleted on pause; L2 repo hooks/fsmonitor run by tend git calls; L3 background writers during pause; L4 unbounded changed[]. All go into the single final fix wave.
- Final review (opus): Not ready — C1 WIP committed off tend branch (detached/switched HEAD) loses work on resume (reproduced); I1 briefing root not repo-relative for subfolder launches; I2 resume doesn't ensure launch dir; minors M1-M7. Single fix dispatch (opus) with all review + security findings: final-fix-brief.md.
- Final fix wave: 152f6e4..e5e766b (opus) + controller 672753f (trust matcher vs real 2.1.312 unnumbered options — real smoke had FAILED before it, PASS after), d6ec9b6 (deleted-worktree pause copy, archive prunes), ec09754 (refused pause/archive leaves Claude running). Scoped re-review (opus): all 15 findings addressed, Ready to merge.
- Parked (follow-ups): repo-wide `git worktree prune` on each worktree resume; New session hint may lag 300 ms; keep the moved WIP sha in the row/event; M6 copy says ~/.tend even with TEND_HOME.
- Ruling: merge v0.2 into main locally and tag v0.2.0, no push — same as v0.1 — cost: one git reset if unwanted.
- Post-merge polish (advisor): narrowed `git worktree prune` to the case where tend's own worktree folder is gone and still registered; version 0.2.0; live UI pass in a real browser (SSE on, fake claude): create with worktree hint → live briefing/facts → Pause → Resume (uncommitted restored, terminal re-attached) → Archive (confirm, row dropped live), 0 console errors; fixed a benign 404 (briefing refetch after archive). Real smoke PASS on the final code.
