# Tend: design

> **Status:** draft for review · **Date:** 2026-10-27 · **Name:** "Tend" is a placeholder
> **Inputs:** [INVESTIGATION.md](./INVESTIGATION.md) (7 tools reviewed), [PAIN-POINTS.md](./PAIN-POINTS.md), [ANTHROPIC-PRACTICES.md](./ANTHROPIC-PRACTICES.md), mockup [mockups/tend-final-v2.html](./mockups/tend-final-v2.html)
> Items marked **(my call)** were decided by Claude, not the user. Check them while reading.

> **Phase 0 outcome (2026-10-28): GO.** See `docs/research/phase-0/RESULTS.md`. These override the sections below:
> (1) the terminal uses **tmux control mode**, with no native pty;
> (2) **permissions and questions are both answered through the PermissionRequest hook** (questions via `updatedInput.answers`), so v1 sends **no keystrokes** and the "undocumented UI" row in §20 is gone;
> (3) answering in the terminal makes Claude close the held hook request, so first answer wins;
> (4) lifecycle comes from tmux pane state, not SessionStart, which isn't delivered to HTTP hooks;
> (5) no step counts in v0.1, since task events weren't observed;
> (6) Tend asks once to trust `~/.tend/worktrees`.

---

## 1. Intent

People who build with Claude Code now run 10–50 sessions across many projects. The agents aren't the bottleneck; the human's attention is. Today that means jumping between VS Code windows and terminal tabs, missing sessions that silently wait for input, forgetting what each one was doing, and re-reading scrollback to get back into context. Anthropic's own 2026 trends report names the missing piece: *"development environments that show the status of multiple concurrent agent sessions,"* so that *"human attention counts where it matters most."*

**Tend is one localhost web page that gives you control of every Claude Code session you start through it** (sessions started elsewhere appear as read-only rows; see §19.1):
- what needs a decision now, with the decision answerable in place
- what every other session is doing and how far along it is
- a briefing for any session, so you can step back in without reading scrollback
- the real terminal, files, diffs and previews in the same window

It must be **ultra thin** (a small codebase that drives the real CLI and re-implements nothing) and **powerful** (keyboard-first, safe, and aware of the whole fleet).

## 2. Users **(my call)**

- **v1:** an individual developer or product owner who builds with Claude Code, on one Mac (Linux should work too), using their own Claude login. That's the user and people like them.
- **Later:** forward-deployed engineers and consultants juggling many client repos and accounts, and small teams.
- Tend is installed by each user and runs only on their machine. There is no hosted service.

## 3. Goals, non-goals, anti-goals

**Goals**
1. You never miss a session that needs you: an OS notification, plus the inbox and the strip.
2. You can answer most decisions without opening the terminal: permissions, plan approvals, review-ready work.
3. You understand any session in 10 seconds through its briefing.
4. You keep full fidelity whenever you go deep: the real Claude Code TUI, plus files, diffs and previews.
5. Parallel work stays safe: a worktree per session, overlap detection, and scoped permissions.

**Non-goals (v1)**
- Re-implementing Claude Code's UI or agent loop, or building on the Agent SDK. We stream the real TUI.
- Git-host APIs (GitHub/GitLab/Bitbucket). Git stays generic and local.
- Harnesses other than Claude Code, phone access, team sharing.
- Kanban boards, pipelines, agent-to-agent chat, extra dashboard pages.

**Anti-goals** (failures even if everything technically works)
- **Inventing progress.** Every on-screen fact must trace to an event, git, or an opt-in AI summary that is labelled as one (§9).
- **Approving something by accident.** That includes a keyboard shortcut landing while focus changes, and risky commands approved without explicit confirmation.
- **Becoming another monolith.** Every tool reviewed grew to 100K–600K lines. Target **≤ 8K lines** of product code for v1, with no file over 600 lines.
- **Phoning home.** No telemetry, no account, no cloud relay.
- **Fighting Anthropic's first-party features.** Build on hooks and `claude agents`. Don't replace them.

## 4. Principles
1. **One screen, no modes.** Awareness, decisions and the terminal are visible together.
2. **Facts over prose.** Buttons and states come from hooks and git, never from parsing Claude's sentences. Parsing text is allowed only for *navigation* (clickable links).
3. **The terminal is the source of truth.** Cards are shortcuts. Anything a card can do, the terminal can do too.
4. **One owner per pending decision.** A decision is answered exactly once, through exactly one channel (§11).
5. **Zero tokens by default.** AI summaries are opt-in, on demand and labelled.
6. **Local and secure by default.** Loopback only, a token, an Origin/Host check, least privilege.

## 5. The experience

The layout follows the agreed mockup (`mockups/tend-final-v2.html`).

```
┌ top bar ──────────────────────────────────────────────────────────────────┐
│ Tend  [fleet strip: one shaped tile per session, grouped by project]  ⌘K  │
├ left 344px ───────────────┬ right ────────────────────────────────────────┤
│ [For you | All sessions]  │ header: name · goal · branch ↑↓ · worktree ·  │
│ Blocked on you            │         step n/m · tests · uncommitted        │
│ Problems                  │ decision bar (only when one is pending)       │
│ Ready for review          │ briefing (collapsible)                        │
│ …or grouped by project    │ terminal tabs [claude][shell][+] │ ⇆ │ files/ │
│                           │                                  │   │ diff/  │
│                           │                                  │   │ preview│
├───────────────────────────┴───────────────────────────────────────────────┤
│ status bar: local · focus state · shortcuts · Claude usage                │
└───────────────────────────────────────────────────────────────────────────┘
```

**Session states:** `working` · `idle` · and the states that need you: `permission` · `question` · `plan` · `stuck` · `overlap` · `review` · `crashed`. Each state has a **shape** as well as a colour: lock, ?, clipboard, triangle, overlapping squares, check, broken circle, spinner, pause.

**Inbox order:** groups **Blocked on you** (permission, question, plan) → **Problems** (stuck, overlap, crashed) → **Ready for review**. Within a group, high-risk comes first, then oldest. Predictable beats clever.

**Key flows**

| Flow | Behaviour |
|---|---|
| **Triage** | J/K moves through decisions. A/D allows or denies a permission (not for high-risk). 1–9 picks a question option (§11). Enter focuses the terminal. Finishing one decision selects the next. |
| **New session** | ⌘N: pick a project, name, prompt, and optionally plan mode. Tend creates a worktree, starts `claude` in tmux, and records the first prompt as the goal. |
| **Step back in** | Selecting a session shows its briefing: Done (with evidence links), Next (Claude's task list), Your instructions, and Needs you. |
| **Review & commit** | Opens the full diff (expandable panel). "Commit & push" sends the user's own command, for example `/commit-push-pr`, into the session, or a configured default prompt. Tend never commits by itself. |
| **Resume** | Idle sessions keep their briefing. "Resume" runs `claude --resume <session_id>` in the same worktree. |
| **Drop or paste an image** | See §6. |
| **Smart links** | Paths open in the file panel, commit SHAs open their diff, branches show a compare, URLs open a new tab, and `localhost:PORT` opens a preview. |

**Example: the user's real case.** The agent says *"Spec written and pushed on branch `docs/acme-rebrand-spec` (commit `dc5dce3`) at `docs/specs/…-design.md`."* The session lands in **Ready for review**, because a `Stop` event arrived and there are commits ahead of base. The facts come from git: branch pushed (it has an upstream and `↑0`), the new commit, and the new file. The card offers **[Read spec]**, a rendered markdown preview of the new `.md`; **[View commit]**; **[Ask for changes]**; and **[Open PR/MR]**, which sends the user's configured command or prompt to the session. The card never claims "no MR is open", because that is a host fact v1 doesn't have.

## 6. Interaction layer: terminal fidelity
A browser terminal must be at least as capable as iTerm/Ghostty, and smarter.

| Need | Design |
|---|---|
| Full Claude Code TUI | xterm.js connected to a real pty that attaches to the session's tmux. Truecolor, Unicode/emoji width, resize (SIGWINCH), mouse, bracketed paste, IME. |
| **Focus rule** | When the terminal has focus, **every key goes to Claude**. Only two chords reach Tend: Esc twice (leave the terminal) and ⌘⇧K (palette). Single-key shortcuts work only when the terminal is not focused. The status bar always shows which mode is active. |
| Paste text | Bracketed paste, so a pasted newline never submits the prompt. Pastes over 10 KB ask before sending. |
| **Drop or paste media** | See §6.1. |
| Drop files or folders | Insert `@`-references resolved inside the session's worktree. A file from outside is copied into attachments first. |
| Clickable links | Detect paths, URLs, 7–40 character hex SHAs (only if `git cat-file -e` succeeds), branch names (only if they exist), and `localhost:PORT`. Also support OSC 8 hyperlinks. |
| Outputs shelf | Files the session created (from git status, newly added) and files under an `outputs/` convention, with previews. |
| Previews | Markdown (with mermaid), images, PDF, HTML (sandboxed iframe), and a `localhost:PORT` dev-server preview (iframe, loopback only). |
| Terminal signals | Bell, OSC 9/777 notifications and title changes go to the event log as backup signals. Hooks stay primary. |
| Search and copy | xterm search addon. "Copy block" on hover over fenced code in the briefing and previews. |

### 6.1 Media: screenshots, images, PDFs, files
A browser terminal can't pass a clipboard image through a pty the way Ctrl+V does in a native terminal. So Tend turns every media item into **a file plus a path** that Claude reads.

**Ways in (all equivalent)**
- **Paste:** ⌘V after ⌘⇧⌃4 (macOS screenshot to clipboard), or a copied image from any app or browser. The page's `paste` event delivers the image.
- **Drop onto the session pane:** an overlay says *"Drop to attach to auth-refactor"*. Accepts files from Finder, the desktop's screenshot thumbnail, or a browser image.
- **Drop onto a list row or strip tile:** attaches to *that* session without switching to it first.
- **Attach button** (📎) in the terminal tab bar opens a file picker.
- **Several at once:** each one is processed and all paths are inserted together.

**Pipeline**
1. Upload through `POST /api/sessions/:id/attachments`, covered by the token. The limit is 25 MB per file, and the type is detected from the file's bytes, not its name.
2. **Normalise:**
   - Convert HEIC/HEIF and TIFF to PNG or JPEG (macOS `sips`, or a bundled converter).
   - Downscale images whose long edge exceeds 2,000 px, keeping the original alongside.
   - **Strip EXIF/GPS** metadata.
   - PDFs pass through, since Claude reads PDFs.
   - GIFs: use the first frame plus a note.
   - **Video:** not supported in v1. Tend says "Claude can't watch video" and offers "extract 5 frames" when `ffmpeg` is installed.
3. **Save where Claude can read it without a permission prompt, and where it never gets committed:** `<worktree>/.tend/attachments/<ts>-<slug>.<ext>`, with `.tend/` added to the worktree's **`.git/info/exclude`** (local only, never touches tracked files or `.gitignore`). In in-place mode, files go to `~/.tend/attachments/<id>/` and the session is launched with `--add-dir` for that folder.
4. **Insert into the prompt** at the cursor as a bracketed paste of the quoted relative path (`".tend/attachments/2026-10-27-1452-login-bug.png"`). Nothing is submitted: the user finishes typing and presses Enter.
5. **Show it.** A chip strip above the terminal shows a thumbnail per attachment for the current prompt. Click to preview, × to remove its path. Sent attachments appear in the session's **Outputs/Attachments** shelf and as evidence in the briefing.

**Lifecycle:** attachments are deleted when the session is archived. In-place attachments are cleaned after 30 days. Nothing leaves the machine.
**Checked in Phase 0:** Claude reads an image from a relative path in the prompt without a permission prompt, on the current Claude Code version.

## 7. Architecture

```
 Browser (one page)                         Tend core (one local process)
 ┌──────────────────────┐   WS /pty/:id     ┌─────────────────────────────────────┐
 │ xterm.js terminals   │◀═════════════════▶│ PTY bridge ── tmux attach -t tend-x │
 │ list · strip · cards │   SSE /events     │ Event bus ──▶ event log (SQLite)    │
 │ briefing · files     │◀─────────────────│ State machine (per-session state)   │
 │ diff · preview       │   REST /api/*     │ Git watcher (fs events + git CLI)   │
 └──────────────────────┘──────────────────▶│ Hook endpoint POST /hook/:event     │
        127.0.0.1 + token + Origin/Host     │ Permission broker (held responses)  │
                                            │ Attachments · Preview server        │
                                            │ Notifier (macOS / libnotify)        │
                                            └──────────┬──────────────────────────┘
                     HTTP hooks (token header)         │ spawns / attaches
             ┌──────────────────────────────┐          ▼
             │ claude (interactive TUI)     │◀── tmux session "tend-<id>"
             │ in ~/.tend/worktrees/<id>    │    (survives Tend restarts)
             └──────────────────────────────┘
             observed only: `claude agents --json` (sessions started outside Tend)
```

- **One process** serves the UI, API, WebSockets and hook endpoint. Sessions live in **Tend's own tmux server** (`tmux -L tend`), so they survive Tend restarts and browser closes. **(my call)** Tend doesn't drive agent-view `--bg` sessions; it reads `claude agents --json` and `~/.claude/projects` only to *show* external sessions, with "Adopt" left for later.
- **Hooks:** Tend launches each session as `claude --settings ~/.tend/sessions/<id>/settings.json`, a Tend-owned file holding its **HTTP hooks**. **Nothing is written into the repo or the worktree.** Claude Code merges these hooks with the user's own (additive). Phase 0 verifies `--settings` merging; the fallback is the worktree's `.claude/settings.local.json`. The hooks POST to `http://127.0.0.1:<port>/hook/<event>` with a per-launch token header (`allowedEnvVars`). The events are SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, SubagentStart/Stop, TaskCreated/TaskCompleted, PreCompact and SessionEnd.
- **Stack (my call):** TypeScript, with a single runtime chosen in the Phase 0 spike (Bun if its pty support is solid, otherwise Node with `node-pty`). SQLite for the event log. A UI with no heavy framework (Preact or plain TS), xterm.js, CodeMirror 6 for viewing and light editing, and `marked` + mermaid for markdown.
- **Packaging:** `npx tend` or a single binary. Running `tend` opens the browser at the tokenized URL.

## 8. Data streams

| Stream | Transport | Content | Rate |
|---|---|---|---|
| **Terminal bytes** | WebSocket per *visible* terminal, binary | Raw pty output both ways | Only for terminals on screen, plus a 200 ms throttled "last line" for list rows |
| **Session events** | Hook POST → event bus → SQLite → SSE to UI | Typed events (below) | Bursty, small |
| **Git facts** | fs watcher on each worktree (debounced 1 s) → `git status --porcelain=v2 -b`, `rev-list --count`, `diff --name-only base...HEAD` | Branch, ahead/behind, upstream, uncommitted, changed files, new commits | On change |

**Event record (append-only):** `{id, ts, session_id, kind, data}`, where `kind` is one of `prompt | tool_start | tool_end | tool_fail | permission_req | permission_resolved | notification | stop | task_created | task_completed | subagent | compact | git_change | crash | user_action`.
The UI's state is a pure fold over events plus the current git facts, so **any view can be rebuilt after a crash**.

## 9. Where every on-screen field comes from
Nothing is shown without a source. AI-derived text is always labelled "AI summary" and is opt-in.

| Field | Source | Notes |
|---|---|---|
| Session name, project, worktree | Tend's creation record | |
| **Goal** | First `UserPromptSubmit` (trimmed to its first sentence), editable | User can rename or rewrite |
| **Your instructions** | Later `UserPromptSubmit` events (last 5) | |
| **Step n of m / Next** | `TaskCreated` / `TaskCompleted` (Claude's task list) | Omitted when the session has no task list. Never estimated. |
| **Done bullets** | Completed tasks + new commits (subjects) + files added + test runs | Each has an evidence link (task, commit, file, tool call) |
| Last action (list row) | Latest `PreToolUse` (tool + key arg) | Or the throttled last terminal line |
| Last message | `Stop.last_assistant_message` | Shown in review cards |
| State `working` | PreToolUse/PostToolUse/UserPromptSubmit since the last Stop | |
| State `permission` | `PermissionRequest` pending | |
| State `question` / `plan` | `PreToolUse` with tool `AskUserQuestion` / `ExitPlanMode`, before its PostToolUse | Exact tool names verified in Phase 0 |
| State `idle` | `Stop` with nothing pending and no new commits | |
| State `review` | `Stop` + commits ahead of base or uncommitted changes, not yet acknowledged | |
| State `stuck` | ≥ 3 `PostToolUseFailure` with the same tool + normalised error in 15 min, **or** no event for 10 min while `working` | The card shows the repeated error verbatim. **No "likely cause" text unless AI is requested.** |
| State `overlap` | Git: the changed-file sets of two worktrees of the same repo intersect | Shows the files and the other session |
| State `crashed` | tmux pane dead or `SessionEnd` without a `Stop` | |
| Tests | Last `PostToolUse` for a Bash command matching the project's test pattern (configurable; default `test`), exit code + summary line | "Unknown" if none |
| Branch ↑↓, upstream, uncommitted, new commits | Git facts | |
| **Risk label** | Rule-based classifier on the command (§11) | Rules shown on hover |
| **Effect text** | **Removed from v1.** The card shows the command, folder and repo, plus the matched risk rule | AI explanation on request only |
| Usage pill (5h / weekly, resets) | Status line `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at`) | Only for Pro/Max subscribers. Hidden when absent. |
| Context % per session | Status line `context_window.used_percentage`, `total_input_tokens`, `context_window_size` | Null right after `/compact`, so Tend keeps the last value greyed out |
| Cache warm / time left | Status line `prompt_cache.warm`, `expires_at`, `recache_tokens_if_cold` | Requires Claude Code ≥ 2.1.251 |
| Compaction events | `PreCompact` hook + the context % drop on the next status update | Shown in the briefing |
| "Using the most" ranking | Deltas of each session's status-line token totals over 30 min | Relative shares only |

### 9.1 Context and usage tracking
**Source:** Claude Code's documented **status line** JSON, not OAuth tokens or transcript files. Claude Code runs the status line command on every update (debounced at 300 ms) and passes it session JSON on stdin.

**Mechanism:**
- Tend's `--settings` file sets `statusLine` to `tend-statusline`, a tiny wrapper that does two things:
  1. POSTs the JSON to Tend (fire and forget, 50 ms timeout).
  2. Runs **the user's own status line command** from their settings, and prints its output unchanged.
- The user's status line keeps working exactly as before. With `refreshInterval: 30`, idle sessions keep reporting.
- Unlike TokenEater, Tend never reads the Keychain OAuth token or calls usage APIs. Everything comes from data Claude Code already hands to its status line.

**Design rules ("no fluff"):**

| Where | What | Shown when |
|---|---|---|
| Top bar | One **usage pill**: `5h ▬▬▬│ 71% · 1h 58m`. The bar fill is coloured by **pacing zone** (chill / on pace / warning / hot), and a tick marks even pace. | Always (if subscriber) |
| Usage popover (click the pill) | 5-hour and weekly bars with pace ticks. **One sentence of projection** ("At this pace you reach the limit around 16:38, 22 min before reset"). The top sessions by share of use over the last 30 min, each clickable. | On demand |
| List row | A 14 px **context ring** next to the time | **Only at ≥ 60%.** Grey under 70%, amber 70–85%, red above 85% |
| Session header | `context 54% · 108k / 200k` and `cache warm · 2m left` | Always, in the facts line |
| Decision bar | "⏱ Prompt cache goes cold in 2 min. Answering after that re-reads about 118k tokens." | Only when a decision is pending **and** the cache expires within 3 min |
| Briefing | Advisory "Context 88%. Claude will auto-compact soon…" with **[Compact at next stop]**, which sends `/compact` when the session next reaches its prompt. Plus "Compacted at 14:20 · 91% → 17%" in Done. | Advisory at ≥ 80%; compaction whenever it happened |
| Notifications | One notification when the 5-hour pacing zone turns **hot**, naming the heaviest session | At most once per window |

**Pacing zone** (borrowed from TokenEater's Smart Color, simplified): `projected = used / elapsed_fraction`.
- **hot:** used ≥ 90% or projected ≥ 115%
- **warning:** used ≥ 75% or projected ≥ 100%
- **chill:** projected < 75%
- **on pace:** otherwise

Add 3 percentage points of hysteresis so the colour doesn't flicker at a boundary. Treat the result as low-confidence for the first 10% of a window.

**Attention routing:** a pending decision whose prompt cache expires within 3 min moves to the top of its group, since a late answer costs real tokens.

### 9.2 Accounts (v1)
Limits belong to a Claude **account**, so every usage number is per account. Context is per session.
- **An account is a Claude config folder** (`~/.claude` or any folder used with `CLAUDE_CONFIG_DIR`), with a name and colour the user picks. Tend lists the `~/.claude*` folders it finds. Logging in stays Claude's job: Tend shows `CLAUDE_CONFIG_DIR=<dir> claude` and the user runs `/login` there once. Tend never reads or stores credentials.
- **Each session runs under exactly one account.** Tend launches it with `CLAUDE_CONFIG_DIR=<dir>`, so every status-line update is attributed to the account Tend launched it with. The JSON doesn't carry the account identity, and doesn't need to.
- **Per-account limits:** the latest `rate_limits` seen from any session of that account. With no active session, the account shows its last values greyed out with "as of 14:05". Tend makes no API calls to refresh them.
- **Where accounts show (only when more than one is configured):**
  - **Top bar:** one compact pill per account (colour dot · 5-hour bar with pace tick · %).
  - **Popover:** a section per account (5-hour, weekly, top sessions by use).
  - **List rows and the header:** a small account dot. Tile tooltips name the account.
- **Choosing the account for a new session:** per-project default, otherwise **the account with the most 5-hour headroom**, always changeable in the New-session dialog. When an account's pace turns hot, the notification suggests starting new work on the other account.
- **Not in v1:** moving a running session to another account. Resuming under a different config folder would mean copying transcripts across folders.
- **Session data stays per account:** `--resume` runs with the session's own `CLAUDE_CONFIG_DIR`.

## 10. Attention routing and notifications
- **Notify** (OS notification and strip pulse) on entering `permission`, `question`, `plan`, `stuck`, `crashed`, or `review`. Group repeats per session (at most one notification per state change). Quiet hours and per-project mute in settings.
- Clicking a notification focuses the Tend tab and selects that session.
- **Never notify** for `working` or `idle` transitions.
- A "Since you left" one-liner appears when the tab regains focus after more than 5 minutes away, built from the event log.

## 11. Decisions and permissions

**One owner per decision.** In v1:
- **Permission requests** are owned by the **Permission broker**. The `PermissionRequest` HTTP hook is held open (timeout configured high, e.g. 3600 s; Claude Code's default for http hooks is 600 s) until the user answers on a card. The broker returns `allow` / `deny`, plus a permission rule for "Always allow".
  - **If the TUI also shows the dialog while the hook is pending** (Phase 0 must verify this), both channels must resolve the same request. A card answer resolves the hook, and the TUI dialog must close as a result. If it doesn't, v1 falls back to **cards that focus the terminal and the user answers there**.
  - **On hook timeout** the card turns into "Answer in terminal". It never silently allows.
- **Questions (AskUserQuestion) and plan approval** have no documented hook answer. In v1 the option buttons **send the matching keystrokes** to the pane: the one place Tend types keys. They do that only after confirming that the pane's last screen contains the question text. Otherwise they just focus the terminal.

**Risk classifier (rules, not AI):**
- **High:** recursive deletes (`rm -r`, `--recursive`, `rmdir /s`), `git push --force`, `git reset --hard` on a shared branch, SQL `DROP|TRUNCATE|DELETE` without `WHERE`, writes or deletes outside the worktree, cloud CLIs with destructive verbs (`aws … rm|delete|terminate`, `gcloud … delete`, `kubectl delete`, `terraform apply|destroy`), `curl|sh`, `sudo`.
- **Medium:** migrations, package installs, network calls, git push.
- **Low:** everything else.
- The rules live in a readable, user-editable file.

**Rules for actions**
- High-risk: no single-key Allow, a two-step confirm, and never eligible for "Always allow".
- "Always allow" always shows the exact pattern and the repository scope, and is saved through Claude Code's own permission rules, not a Tend-only list.
- Single-key actions are ignored while the terminal has focus, and for 500 ms after the selected session changes (guards against a mis-hit during a switch).

## 12. Git (generic, local)
- **Worktree per session** under `~/.tend/worktrees/<id>` on branch `tend/<slug>`, created from the project's current HEAD. The base SHA is pinned at creation.
- **Pause:** commit WIP to the branch and remove the worktree. **Resume** recreates it. Borrowed from Claude Squad; re-implemented, since its code is AGPL.
- **Overlap detection** across sessions of the same repo: an intersection of `git diff --name-only <base>...HEAD` plus uncommitted paths, refreshed on git change.
- **Commit, push and PR/MR** happen *through the session*: Tend sends the user's configured command (default: "Commit the work with a clear message and push the branch"). A PR/MR URL appearing in the output is linked. Tend never pushes on its own.
- **Cleanup:** archiving a session removes its worktree. Deleting it also deletes the branch, after a confirm.

## 13. Memory and briefings
- The event log (SQLite) is kept for 30 days by default, configurable, and is the memory. Briefings are views over it, so a session opened days later shows the same briefing.
- **Opt-in AI summary:** runs `claude -p` (the user's own login) over the session's events and diff, writes back an event labelled `ai_summary`, and shows its token cost.
- Tend never writes to the user's CLAUDE.md on its own. "Add to CLAUDE.md" (from review) drafts a line for the user to confirm.

## 14. Crash recovery and restart
- **Tend restarts:** it rebuilds state from SQLite, re-lists the `tmux -L tend` sessions, and reattaches. Sessions whose pane is dead become `crashed` and offer "Resume" (`claude --resume`).
- **A held permission hook that dies with Tend:** the hook gets a connection error, and Claude Code falls back to its normal flow (the TUI dialog). Phase 0 verifies this. The card becomes "Answer in terminal".
- **Browser closes:** nothing stops. Notifications need the core, not the tab.
- **The selected session crashes:** the decision bar shows "Session ended unexpectedly" with Resume / View log. The terminal keeps its scrollback (tmux history).

## 15. Security
- Binds to 127.0.0.1 only. A random token is generated per launch and required on every request, WebSocket and hook POST (compared in constant time). Origin and Host header checks guard against DNS rebinding.
- Agents run unsandboxed with the user's privileges, the same as running `claude` yourself. Tend adds no auto-approval of any kind.
- The preview iframe is sandboxed. Dev-server previews are loopback-only.
- No telemetry. No outbound network except what Claude itself does.

## 16. Scope

**v1:** fleet strip, list (For you / All), detail with decision bar, briefing, terminal (claude + shell tabs), files/diff/preview panel, smart links, image and file drop/paste, notifications, permission broker with risk rules, question/plan buttons (verified keystrokes), worktrees with local git facts, overlap detection, pause/resume, crash recovery, ⌘K palette, light/dark themes, **context and usage tracking (§9.1), multiple accounts (§9.2)**.

**Later:** moving sessions between accounts, adopting external sessions, git-host integrations, other harnesses (Codex etc.), phone access (tunnel or chat bridge), AI review assist, team sharing, pipelines.

## 17. Phase 0 spike (do before planning in detail; about 2–3 days)
1. **pty + tmux + xterm.js** on the chosen runtime: fidelity of the Claude Code TUI (colours, menus, Shift+Tab, Esc, resize, bracketed paste, IME, emoji).
2. **PermissionRequest hook:** does the TUI dialog show while the hook is pending? Does a hook answer dismiss it? What happens on timeout, or when the hook server is gone? Can we return a permission rule (exact field name)?
3. **AskUserQuestion / ExitPlanMode:** confirm the PreToolUse tool names and input shape, and whether sending keystrokes after verifying the screen is reliable.
4. **Task events:** do `TaskCreated` / `TaskCompleted` fire for Claude's normal task list in interactive sessions?
5. **Image by path:** dropping a path into the prompt makes Claude read the image.
6. **Field audit:** walk §9 and confirm each source exists in practice. Anything that fails is cut or marked unavailable.
7. **Load:** 20 sessions, 3 visible terminals, CPU and memory of the core and the browser.

## 18. Test scenarios (acceptance)
1. Two sessions edit the same file → both show `overlap` within 2 s of the second write. Neither is blocked automatically.
2. A high-risk permission arrives while the user is typing in another session's terminal → no keystroke affects it, a notification fires, and Allow needs a two-step click.
3. The selected session crashes → the state becomes `crashed`, scrollback is preserved, and Resume works.
4. Tend is killed with a permission pending → Claude falls back to its TUI dialog. After restart the card says "Answer in terminal".
5. An image is pasted into a session → the file is saved outside the repo, the path is inserted, and Claude describes the image.
6. The user's spec example (§5) → the card shows Read spec / View commit / Ask for changes / Open PR/MR, and every fact matches git.
7. 20 sessions run for 8 hours → no event lost; the UI stays responsive (< 100 ms input latency in the focused terminal).
8. Single-key actions are ignored while the terminal has focus, and for 500 ms after switching sessions.

## 19. Decisions from the builder review (all my calls unless marked)

1. **External sessions in v1 are list rows only.** They show name, folder and state from `claude agents --json`, plus "Open in terminal" (runs `claude attach`). They have no hooks, decisions, briefing or embedded terminal. Full control requires starting the session in Tend. "Adopt" (restarting an external session under Tend with `--resume`) comes later.
2. **Where sessions run.**
   - **Git repo (default):** a new worktree from HEAD. If the main checkout is dirty, Tend warns "uncommitted changes aren't included" and offers **Include them**, which copies the uncommitted diff into the worktree.
   - **Gitignored files the agent needs** are copied in from a per-project include list (default `.env*`). Dependency folders (`node_modules` etc.) are not copied; the agent installs them, and the project can define a setup command.
   - Submodules: `git submodule update --init` when present.
   - **Non-git folder, or the user opts out:** "in place" mode runs in the folder itself. There is no worktree, no overlap detection and no pause; everything else works, since hooks come through `--settings`.
3. **Delivery:** v1 ships via `npx tend` (the audience has Node). A single binary is later. The Phase 0 runtime pick must work with `npx` on macOS arm64 and Linux x64.
4. **Minimum bar for v1 and go/no-go.** *This is the user's call, recommendation shown.*
   - **Stop the project if** the browser terminal can't run the Claude Code TUI faithfully (Phase 0 item 1).
   - **Shrink, don't stop, if** card answers for permissions can't work cleanly: permission cards become "focus the terminal and answer there".
   - **Shrink, don't stop, if** keystrokes for questions are unreliable: question cards focus the terminal.
   - **v1 ships with at least:** fleet strip, inbox, notifications, briefings, terminal, worktrees, overlap, files/diff/preview.
5. **Claude Code compatibility.**
   - Tend finds `claude` on PATH (overridable), checks a minimum version at startup, and shows which hook events are missing.
   - Features whose events are missing degrade (for example, no "step n of m" without task events).
   - Tend **never** passes `--dangerously-skip-permissions`. The user's own permission modes and hooks work as usual alongside Tend's.
6. **Size budget is a guide, not a gate:** about 8K lines of product code including the frontend, excluding tests. Libraries are fine (xterm.js, CodeMirror, marked, mermaid). If it's exceeded, cut light editing, then PDF preview, first.
7. **One instance, stable address.**
   - A single-instance lock (`~/.tend/tend.lock`).
   - A fixed default port (4977, configurable).
   - The hook token is persisted in `~/.tend/token` (0600) and stays stable across restarts, so running sessions' hooks keep working. `tend rotate-token` restarts the hooks for every session.

## 20. Surviving Claude Code updates (user requirement: never a broken version)
Claude Code updates itself often. Tend must **never become broken** by an update. At worst, one shortcut temporarily falls back to the terminal, which always works.

**1. Coupling budget: every dependency on Claude Code, ranked by stability**

| Dependency | Stability | If it changes |
|---|---|---|
| The TUI itself (streamed, never parsed) | n/a | Nothing breaks. Tend shows whatever Claude renders. |
| `claude` CLI flags: `--settings`, `--resume`, `--add-dir` | Documented | Startup check fails loudly with the exact flag. Sessions still run in the terminal. |
| Hook events and fields (documented API) | Documented, versioned | A missing or renamed field means that one feature degrades (e.g., no step count). State falls back to the terminal-activity heuristic. |
| `PermissionRequest` card answers | Documented | Cards fall back to "Answer in terminal". |
| Answering questions by sending keystrokes | **Undocumented UI behaviour** | **Off by default.** Enabled only when the conformance check passes for the *exact* installed version. Otherwise question cards focus the terminal with the question visible. |
| `claude agents --json` (external rows) | Research preview | External rows hide. Nothing else is affected. |
| Transcript JSONL format | Explicitly unstable | **Not used.** |

**2. Conformance check on every version change**
- Tend records `claude --version` at startup and every hour.
- On a new version it runs a **self-test** in a throwaway temp repo: start a session with Tend's settings, send a trivial prompt that triggers a harmless tool call, a permission request and a stop, then check that every expected hook event arrives with the expected fields.
- Cost: one tiny prompt, using the cheapest model, about 1K tokens. It can be disabled. If disabled, Tend uses "safe mode" for unverified versions.
- **Result per feature:** ✅ enabled, or ⚠️ fell back to terminal, with the reason. Shown once as a banner ("Claude Code 2.1.310: question shortcuts paused until verified") and in Settings → Compatibility.
- The tested-versions list ships with Tend and is updated by the self-test locally, so a version only needs checking once.

**3. Rules for the codebase**
- Each Claude-specific assumption lives in **one adapter module** with a contract test. No hook field names or CLI flags outside it.
- Every feature defines its terminal fallback *before* it's built. Code review rejects a feature without one.
- CI runs the conformance suite against the latest Claude Code release daily (borrowed from AI Code Conductor's live-CLI conformance CI). A failure opens an issue before users hit it.

**Result:** an update can at worst turn a card into "answer in terminal". It can never corrupt sessions, auto-approve anything, or leave Tend unusable.

## 22. Focus and sustainable pace (the Tend promise, v1)
The brand promises calm, so the product has to deliver it. These come from the research: batch your review, limit work in progress, watch out for "AI brain fry". All are **(my call)** for v1.

1. **Focus windows (decision batching).**
   - Only interrupting states notify immediately: **high-risk permissions, stuck and crashed.**
   - Everything else (reviews, low-risk questions and permissions) collects silently. It's released together every 25 minutes (configurable), or when the user presses "Show now".
   - The inbox always shows held items. Only notifications are batched.
2. **Quiet hours and an interruption budget.** Set hours and a maximum number of interruptions per hour. Tend holds the rest and says so: *"Held 6 items during quiet hours."*
3. **Soft limit on parallel work.** The user sets their number (default 8 active sessions). Going past it shows a gentle, dismissible note on New session. Nothing is blocked.
4. **Park everything.** One action asks every working session to finish its current step and stop. Each session's state is saved for a briefing, and tomorrow's "Since you left" starts there.
5. **Daily wrap-up** (opt-in, at a time the user picks), built from the event log:
   - decisions made
   - sessions finished
   - commits
   - interruptions received and interruptions held
   - time spent waiting on you

   It shows the cost of attention, not only the output.
6. **Pacing language:** usage tracking (§9.1) is framed as "keeping a sustainable pace", not as limits.

**Brand reference:** `brand/tend-brand.html` (logo, colour, type, icons, voice, applications). The amber rule from the brand book is a UI rule too: amber marks only things that need the user, at most one per element.

## 21. Left to the builder
Internal module layout, exact table schema, CSS and tokens (follow the mockup), debounce values, attachment retention, palette ranking, settings UI, how the 200 ms last-line sampling is implemented, the test framework.
