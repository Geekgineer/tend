# v0.4 awareness: results (2026-10-29, Claude Code 2.1.312, tmux 3.8, Node 26, macOS)

**Verdict: GO.** All 9 criteria met. 266 tests pass; typecheck and `npm run check` are clean; no file over 600
lines. The real-claude smoke (`scripts/smoke/usage.mjs`, haiku) passes on the final code.

| # | Criterion | Evidence |
|---|---|---|
| 1 | Wrapper | `bin/tend-statusline.mjs` + `src/statusline.ts`. `test/unit/statusline.test.ts`: project local > shared > account; never Tend's own wrapper; `disableAllHooks` honoured. `test/e2e/usage.test.ts`: the user's own status line output still shows (`USER-SL`); no token in the command. Security review verified on real 2.1.312 that a `--settings` statusLine does not run before the trust dialog is accepted. |
| 2 | Context per session | `test/unit/usage.test.ts`: fixture values exactly (6%, 59,743 tokens, 1M, cache warm / expiry / re-cache tokens); a null % keeps the last value marked stale; values range-checked. |
| 3 | Usage per account | `/api/usage`: 5-hour and weekly with pacing, projection, top sessions (one sample per 10 s, 30-minute window). e2e: survives a restart (flushed on shutdown). |
| 4 | Pacing zones | Unit table: thresholds, hysteresis both ways, zone by used % only in the first 10% of a window (no red at every window start). |
| 5 | Accounts | e2e with two temp config folders: listed, explicit choice, "roomiest" only among reporting accounts, default = last account used in that folder, unknown → 400, `CLAUDE_CONFIG_DIR` at launch. `~/.claude` launches with `env -u CLAUDE_CONFIG_DIR` (exercised by the real smoke). Folders are listed only if they look like a Claude config. |
| 6 | UI | Screenshots `shots/*-usage.png` (pill + popover), rings at 74% (amber) and 91% (red), header `context 74% · 740k / 1M`, cache facts. `test/unit/usage-ui.test.ts` for ring levels, facts, cache warning. |
| 7 | Notification | e2e: one "Keeping a sustainable pace" notification when the 5-hour pace turns hot, none on the next update. |
| 8 | Real smoke | Tend's context % (6), tokens (59,081), size (1M), 5-hour (6%, same reset) and weekly (71%) equal the JSON Claude passed to the status line; the project's own status line still shows. |
| 9 | Quality and security | Opus review (5 Important) and security review (1 Medium, 5 Low): all fixed in `21f9b3f`, then a scoped re-review. |

## Real-claude usage
About 6 short haiku sessions (2 smoke runs, the status line / refreshInterval check, plus the reviewer's pre-trust check).
