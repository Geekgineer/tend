# v0.2 memory: go/no-go criteria (written before the plan)

**Scope (strict):**
- A briefing per session, built from the event log with zero AI tokens.
- Local git facts.
- A worktree per session, or in-place mode.
- Overlap detection.
- Pause/resume, resume of ended sessions, and archive.

**Not in scope:** permission/question cards (v0.3); context, usage and accounts (v0.4); focus features (v0.5); AI summaries; files/diff panel; image drop.

**Facts verified before writing this:**
- `claude --session-id <uuid>` followed by `claude --resume <uuid>` restores the conversation. Tested with real haiku on 2026-10-28: it remembered "PELICAN".
- Sanitised fixtures now keep repo-relative file names (`/REPO/hello.txt`).

| # | Criterion | Evidence required |
|---|---|---|
| 1 | **Briefing.** `GET /api/sessions/:id/briefing` returns the following, built only from stored events: <ul><li>goal (first prompt)</li><li>your instructions (later prompts)</li><li>done (each turn's final message and the files edited in that turn)</li><li>all edited files (repo-relative, deduplicated)</li><li>the current state</li></ul>Replaying the Phase 0 fixtures gives the hand-written expected briefing. The UI renders it as text only (never innerHTML from event data). | Unit test on fixture replay; XSS test |
| 2 | **Worktree on create.** For a git repo, "New session" creates `$TEND_HOME/worktrees/<id>` on branch `tend/<slug>-<id>` from HEAD, records the base SHA, and starts Claude in the same subfolder the user picked. If the main checkout is dirty, the response warns that uncommitted changes aren't included. A non-git folder, or the user's opt-out, runs in place. Names with `-` prefixes, spaces, `#`, `;` or unicode still give a valid branch (`git check-ref-format`). | Integration tests on temp repos |
| 3 | **Git facts.** <ul><li>All sessions: branch, uncommitted count, and ahead/behind its upstream (none if there is no upstream).</li><li>Worktree sessions also: commits since base, and changed files (`base...HEAD` plus uncommitted).</li><li>In-place git sessions: changed files are the uncommitted paths.</li></ul> Every background git read uses `--no-optional-locks`: 200 fact reads running alongside 50 commits cause zero `index.lock` errors. | Integration tests on temp repos, lock-contention test |
| 4 | **Overlap.** Two worktree sessions of the same repo (same `git rev-parse --git-common-dir`) whose changed-file sets intersect are both flagged `overlap`, naming the shared files and the other session, at the next refresh (≤ 2 s after a hook event). Overlap is a flag; it never replaces `needs_you`. In-place sessions are excluded. Entering overlap sends exactly one notification; refreshes and restarts send none. | Integration test (fake claude edits the same file in two worktrees) |
| 5 | **Pause / resume.** <ul><li>**Pause** stops Claude, commits a dirty tree as one WIP commit on the `tend/` branch (with `--no-verify -c commit.gpgsign=false`) and stores its SHA, then removes the worktree without `--force` and keeps the branch. A clean tree makes no commit. If the worktree can't be removed, pause is aborted with an error and the worktree is kept.</li><li>**Resume** recreates the worktree at the same path, runs `reset --mixed HEAD~1` only if HEAD equals the stored WIP SHA, and starts Claude with `--resume <uuid>`, or `--session-id <uuid>` if the session was never prompted.</li><li>The files come back byte-for-byte, and a real commit made before pausing is never reset.</li></ul> | Integration tests on temp repos (fake claude) |
| 6 | **Resume ended sessions.** An ended or crashed session (in place or worktree) restarts Claude in the same folder with `--resume <uuid>` and leaves `ended`. Tend never uses `--continue`. A real-claude smoke run checks that a resumed session remembers a word given before the restart. | Integration test + real haiku smoke |
| 7 | **Archive.** Archiving kills the tmux session, WIP-commits a dirty tree, removes the worktree (no force) and keeps the branch, then hides the session from the list. The session's events are kept. | Integration test |
| 8 | **Restart.** After the core is killed and restarted, briefings, git facts, paused and archived flags, and overlap come back, and no notification is sent during the rebuild. | E2E test |
| 9 | **UI.** Headless-Chrome screenshots at 1720×1000 and 1280×800, dark and light: <ul><li>the session header (branch, ↑↓, worktree or in-place, uncommitted)</li><li>the collapsible briefing above the terminal</li><li>Pause / Resume / Archive</li><li>the New session dialog with the branch it will create and an in-place choice</li><li>list rows showing overlap and paused</li></ul>None of them shows overlap or clipping. | Screenshots reviewed |
| 10 | **Quality and security.** `npm run check` and all tests are green, and no file is over 600 lines. Every new route needs the token and validates the session id. Git runs argv-only, with `--` before positionals. Branch names are validated. A security reviewer subagent and the final code review report no open Critical or Important findings. | Command output + review reports |
| 11 | **Trust dialog.** A session showing Claude's "trust this folder" dialog becomes *needs you* (trust), with one notification. Tend never accepts the dialog itself. *(Amended during the build: Claude stores trust per git repo, so after the first session in a repo, later worktree sessions never show the dialog. The planned one-time worktree-folder setup was removed as useless; real-claude smoke evidence.)* | E2E test + real smoke |

**Stop and report if:** real `claude --resume` fails to restore a conversation inside a Tend tmux session (resume would then have to fall back to a fresh session), or worktree removal can't be done without `--force` in normal cases.
