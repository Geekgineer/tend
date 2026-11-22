# v0.4 awareness: ledger

Execution: native, then opus whole-branch and security reviews, one fix wave, real-claude smoke.

## Rulings
- **Source = Claude's status line only** (spec §9.1). No credentials, no usage API, no transcripts.
  Verified on 2.1.312: a `--settings` statusLine runs, `refreshInterval` re-runs it while idle, `rate_limits`
  arrive before the first prompt.
- **The wrapper runs the user's own effective statusLine** (project local > project shared > the account's
  settings) with the same stdin and prints its output unchanged; `--settings` would otherwise hide it (Phase 0b).
  The token sits in a 0600 `status.json`, never in argv. Cost if wrong: the user's status line could look
  different from plain Claude; the real smoke checks a project statusLine still shows.
- **Status updates are fire and forget (300 ms)**; Tend down means the user's status line still prints.
- **Context saved every 10 s per session, usage every 10 s per account (and on hot, and on shutdown).** Status
  updates arrive every ~300 ms per busy session; writing each one would be wasteful. The UI is told only when a
  shown value changes.
- **Accounts = config folders** (default + `~/.claude-*` / `~/.claude<N>`; `TEND_ACCOUNTS` replaces the scan).
  Rows from before v0.4 run under the default folder. New sessions go to the account with the most 5-hour
  headroom; the dialog shows a choice only with 2+ accounts.
- **Colours:** chill green, on pace grey, warning amber, hot red. Amber elsewhere still means "needs you"; a
  warm usage bar is the one exception, matching the spec's pacing zones.
- **"Compact at next stop"** (sends `/compact` as keys) is parked; the advisory text is shown at ≥ 80%.

## Parked
- "Compact at next stop" button.
- Attention routing by prompt-cache expiry (a decision whose cache goes cold soon moves up its group).
- Per-project default account.

## Reviews and fixes (`21f9b3f`)
- **Default account** (review I1, security M1): no longer "roomiest". A new session runs under the account last
  used in that folder, else the default; "Most room right now" is an explicit choice among accounts that report.
  Cost if wrong: one more click to spread work across accounts.
- **`~/.claude` launches with `CLAUDE_CONFIG_DIR` unset** (`env -u`), never set to `~/.claude` (review I2).
- **Project statusLine before trust** (review I3): settled by the security review's real-claude test: Claude does
  not run a `--settings` statusLine before trust, so the wrapper can't either.
- **Pacing early in a window** (I4) and **sample spacing** (I5) fixed. "Using the most" measures context growth
  from `total_input_tokens` + `total_output_tokens`; a session re-reading a large cached context shows a small
  share. Accepted: it ranks who is growing, which is what fills context and usage fastest.
- Briefing advisory at 80% is shown in the header facts (`auto-compact soon`) rather than inside the briefing.
- The account dot on list rows is parked (accounts show in the pills, popover and dialog).
