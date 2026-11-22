# Production soak (v1.0.2)

This test is not a regression suite. It runs real work under real conditions: 4 real Claude Code sessions (haiku) do multi-turn developer work in temp copies. A simulated person drives them through the browser while failures are injected. An oracle compares tend's state with Claude's actual screen every 15 s.

Run it with `SOAK_MINUTES=60 SOAK_OUT=<dir> node scripts/perf/soak.mjs`. It exits 1 if there are any findings.

## Setup
- **slugs** and **kebab:** worktrees of a tend clone, both editing the same file, so the overlap warning must fire.
- **inventory:** a Python project with a planted bug. Its turns include a plan-mode turn and a `rm -rf` turn that is high risk and must be denied.
- **notes:** an in-place folder. Its turns include an image attachment and a question card.
- **Cards:** answered in the browser (high risk is denied with a note), and about 20% are answered in the terminal instead.
- **Chaos, one step at a time:**
  - restart tend (22%);
  - pause and resume inventory, checking that the files are unchanged (38%);
  - kill the notes terminal, which must be flagged as a crash, then resume it (55%);
  - restart tend again (72%).

## Run 1: 60 minutes
Load: 649 turns, 76 cards (56 allow, 4 deny, 11 answered in the terminal, 4 questions, 1 plan), 2 restarts and 196 oracle ticks.

Performance: API p95 1.7 ms, keys p95 1.6 ms, RSS 106–131 MB.

| Finding | Real? | Fix |
|---|---|---|
| Dry runs: state went stale after a tend restart (hooks are lost while tend is down) | yes | `pane-sync`: re-syncs idle and needs-you state from Claude's screen when hooks have gone quiet |
| Dry runs: the busy line `· Germinating… (1s · thinking)` wasn't recognised | yes | widened the busy regex |
| Killed session not flagged as crashed | yes | real Claude sends `SessionEnd` with reason `other` when its terminal is killed. Any SessionEnd the user didn't ask for (not `/exit`, `/clear` or logout) is now a crash |
| Resume button not found | harness | the harness now re-selects the session before clicking |

## Run 2: 20-minute confirmation (after the fixes)
- **Load:** 258 turns (slugs 51, kebab 66, inventory 69, notes 37) and 66 cards (46 allow, 1 deny, 16 answered in the terminal, 2 questions, 1 plan).
- **Chaos:** both restarts, pause/resume and kill/resume all passed.
- **Oracle:** 59 ticks.
- **Findings:** 0.
- **Performance:** API p95 1.7 ms, keys p95 1.7 ms, RSS 98–129 MB.

**Verdict:** go.
