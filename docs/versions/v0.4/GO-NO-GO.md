# v0.4 awareness: go/no-go criteria (written before the plan)

**Scope (strict):** context and usage tracking from Claude Code's own status line JSON (spec §9.1) and multiple
accounts as Claude config folders (§9.2). **Not in scope:** focus windows, quiet hours, interruption budget
(v0.5); "Compact at next stop" (sends keys; parked); moving sessions between accounts.

**Facts verified before writing this (real Claude Code 2.1.312, 2026-10-29):**
- A `statusLine` command set through `--settings` runs and its output is shown (it wins over project settings,
  Phase 0b). `refreshInterval: 10` re-ran it every 10 s while idle.
- The JSON on stdin carries `context_window` (`used_percentage`, `total_input_tokens`, `total_output_tokens`,
  `context_window_size`), `rate_limits.five_hour/seven_day` (`used_percentage`, `resets_at` in epoch seconds)
  even before the first prompt, `prompt_cache` (`warm`, `expires_at`, `recache_tokens_if_cold`), `model`.
- `used_percentage` is null before the first turn.
- The user has no statusLine of their own today and one config folder (`~/.claude`).

| # | Criterion | Evidence required |
|---|---|---|
| 1 | **Wrapper.** Tend's settings set `statusLine` to `tend-statusline` (absolute node + script path, `refreshInterval: 30`). It POSTs stdin to `POST /status` with the hook token, session and launch headers (fire and forget, ≤ 300 ms), then runs the user's effective statusLine command (project `.claude/settings.local.json` > project `.claude/settings.json` > `<config dir>/settings.json`) with the same stdin and prints its output unchanged. No token in argv. Tend never reads credentials or calls a usage API. | Unit tests on the resolver; e2e with fake claude driving the wrapper |
| 2 | **Context per session.** `SessionView.context = {pct, tokens, size, model, cache: {warm, expiresAt, recacheTokens} | null, at}` from the latest status. A null `used_percentage` keeps the last value, marked stale. Values equal the fixture values exactly. | Unit test on fixtures |
| 3 | **Usage per account.** `GET /api/usage` lists each account (config folder) with the latest 5-hour and weekly `used_percentage` and `resets_at`, when seen, a pacing zone, a one-sentence projection and the top sessions by share of tokens used in the last 30 min. Survives a restart (greyed "as of"). | Unit + e2e restart test |
| 4 | **Pacing zones** (spec §9.1): hot ≥ 90% or projected ≥ 115%; warning ≥ 75% or projected ≥ 100%; chill projected < 75%; else on pace; 3-point hysteresis; low confidence in the first 10% of a window. | Unit table test |
| 5 | **Accounts.** Accounts = the default config folder plus `~/.claude-*`/`~/.claude<N>` folders. Each session runs under exactly one (`CLAUDE_CONFIG_DIR` at launch, stored on the session, reused on resume and for transcript checks). New session picks the account with the most 5-hour headroom unless the user chooses; the dialog shows a choice only when there are 2+. An unknown account is a 400. | E2E with two temp config folders |
| 6 | **UI.** Top bar: one usage pill per account (bar coloured by zone, even-pace tick, %, time to reset); click → popover with 5-hour and weekly bars, the projection sentence, top sessions (clickable). List rows: a context ring only at ≥ 60% (grey < 70, amber 70–85, red > 85). Header facts: `context 54% · 108k / 1M` and `cache warm · 2m left`. A decision card warns when the prompt cache goes cold within 3 min. Briefing advisory at ≥ 80%. All text via textContent. | Screenshots + UI unit tests |
| 7 | **Notification.** One notification when an account's 5-hour zone turns hot, naming the heaviest session, at most once per window. | Unit test |
| 8 | **Real smoke (haiku):** a real session's context %, tokens and both usage windows reach Tend and equal the JSON Claude passed to the status line. | Script output |
| 9 | **Quality and security.** check/typecheck/tests green; `/status` requires the hook token and live launch (stale → dropped); status bodies capped; review + security review with no open Critical/Important. | Command output + reports |

**Stop and report if:** the status line from `--settings` stops running, or the JSON loses `rate_limits`.
