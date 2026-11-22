# Critical soak (v1.1.1): real Claude, the Review tab, and a page that must never look stuck

This run extends the v1.0 production soak (`docs/versions/v1.0/SOAK.md`). It uses 4 real Claude Code 2.1.318 sessions on haiku, all in temp copies. A simulated developer drives them through tend in headless Chrome:
- They type turns into the terminal and answer cards.
- About half the time they **review Claude's changes in the Review tab** first: open files, switch views (diff, source, preview), mark files viewed, and sometimes comment on a line and **send the review to Claude**.
- Waits are answered in the terminal when the page says so.

Five failures are injected:
- tend is restarted twice;
- inventory is paused and resumed, and its files must be unchanged;
- **the page is reloaded mid-review**;
- the notes terminal is killed (it must be flagged as a crash), then resumed.

Two oracles check every 15 s:
- **The screen oracle** (from v1.0) compares tend's state with Claude's real screen.
- **The new UI oracle** checks the page itself:
  - how fast it answers;
  - main-thread blocks (anything over 1.5 s is a finding);
  - what the page shows for each session vs the server (a page that stopped updating looks stuck);
  - the terminal in the page vs Claude's real screen.

Run it with `SOAK_MINUTES=60 SOAK_OUT=<dir> node scripts/perf/soak.mjs`.

## What it found (all fixed, each with a test)
| Finding | Cause | Fix |
|---|---|---|
| Pause failed; the session ended but wasn't paused | `mypy` (and pytest, ruff) caches carry their own `*` `.gitignore`, so git listed the folder *and* its insides; moving the folder left the rest pointing at nothing | `ignoredEntries` keeps only the top-most entries |
| "Working" while Claude sat idle | 2.1.318's prompt suggestions run their command ahead *after* `Stop` (a sub-agent `PreToolUse` with `agent_id`, then `SubagentStop`, and no `Stop`) | a sub-agent's tool events outside a turn don't change the state |
| "Working" for ~100 s after a restart | a `Stop` lost while tend was down; Claude's 60 s "waiting for your input" Notification then reset the quiet clock that pane-sync waits on | the `idle_prompt` Notification ends the turn |
| A review comment could go to the wrong session | switching sessions while a file was loading let the previous session's file land in the new view | in-flight loads are dropped on a switch; no stale Send button |
| The page blocked for 1.3 s on a minified file | highlighting a 1.2 MB line | no colour past 300 KB; lines cut at 2,000 characters |
| A rare xterm `dimensions` TypeError | the terminal was disposed before xterm's own next-frame repaint | dispose on the next frame |
| An old test began failing as days passed | a recorded cache expiry in the past | the fake Claude's expiry is an hour from now |

The harness issues it surfaced (two hands on one page, false "could not" matches, timing of typed text) were fixed in the harness.

## Runs
- **60 min:** 437 turns, 205 reviews, 511 files opened, 44 reviews sent. Findings: 2 real bugs (pause, prompt suggestions), 1 knock-on, 1 harness.
- **30 min:** 237 turns, 113 reviews, 29 sent. Findings: the lost-`Stop` case and the xterm error, both fixed after.
- **30 min, final, every fix in:** **233 turns, 0 findings.**
  - Reviews: 119 reviews, 270 files opened, 36 reviews sent and all delivered.
  - Cards: 91 allowed, 2 denied, 26 answered in the terminal, 4 questions, 1 plan.
  - Page: ping p95 0.8 ms, no main-thread block over 200 ms, files shown in 105 ms (p50).
  - Server: API p95 1.9 ms, memory 121–134 MB.

**Verdict:** go.
