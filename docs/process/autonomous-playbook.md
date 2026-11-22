# Tend: autonomous build playbook (no human in the loop)

The user asked for fully autonomous development (2026-10-28). This adapts the version ladder and quality gates so that every human gate becomes an automated one.

## Boundaries (the only things that stop and ask)
1. **Anything outside this machine:** pushing to a remote, publishing (npm, Homebrew), buying domains, posting anywhere.
2. **A pre-written stop criterion fails** (for example, Phase 0 shows the browser terminal can't run Claude Code faithfully). Then I report evidence and options instead of improvising a new product.
3. **Touching the user's real repos or real Claude sessions** beyond read-only. All testing uses temp repos and throwaway sessions.
4. **Spending:** real `claude` runs use the cheapest model and tiny prompts. The budget is about 50 short sessions per version. If it would be exceeded, I stop.

## Human gates → automated replacements

| Human gate (old) | Automated replacement |
|---|---|
| User reviews each plan | **Advisor** review + a fresh **plan-review subagent** that checks the plan against the design doc before execution |
| User reviews security/adapter changes | A dedicated **security reviewer subagent** per version + the `security-review` skill on the branch |
| User dogfoods 2–3 days | An **automated dogfood harness**: scripted day-in-the-life scenarios (fake `claude` replaying recorded events) + a real-`claude` smoke run in temp repos |
| User decides go/no-go | **Go/no-go criteria written before each version starts**, checked by evidence (command output, screenshots) |
| User spots UI problems | **Headless-Chrome screenshots** of every key screen at 1720×1000 and 1280×800, light and dark, checked each version |
| User reports bugs | Bug log per version: each escaped bug gets a failing test, a fix, and a note on which gate missed it |

## Per-version loop
```
write go/no-go criteria → writing-plans (2–5 min tasks) → advisor + plan-review subagent
→ using-git-worktrees → subagent-driven-development (TDD + spec review + quality review per task)
→ verification-before-completion → code-review (branch) + security reviewer
→ automated dogfood harness + screenshots → acceptance scenarios → merge + local tag → next version
```

## Version ladder (unchanged goals, automated "done when")
| Version | Done when (automated evidence) |
|---|---|
| v0.0 spike | §17 checklist answered with recorded output; real hook and status-line payloads saved as fixtures |
| v0.1 skeleton | E2E: 5 fake sessions + 1 real `claude` show correct states; notification fires; terminal round-trips keys |
| v0.2 memory | Briefing matches the fixture-derived expectations; worktree, overlap and pause/resume pass on temp repos |
| v0.3 decisions | 20 scripted permissions resolved through cards; typing-safety and high-risk tests pass; zero mis-approvals |
| v0.4 awareness | Context and usage values equal the status-line fixture values; per-account attribution test passes |
| v0.5 calm | Focus-window batching and quiet-hours tests pass; the day-in-the-life harness shows fewer interruptions |
| v1.0 | All acceptance scenarios, conformance suite green on the installed Claude Code, packaging works from a clean dir |

## Architecture decisions taken autonomously
- **Runtime: Node (installed v26) + TypeScript.** Bun isn't installed.
- **Terminal transport: tmux control mode (`tmux -C`)** instead of a native pty addon, if the spike confirms it renders Claude Code faithfully. No native modules means `npx tend` just works.
- **tmux installed via Homebrew** (3.8) on 2026-10-28.
