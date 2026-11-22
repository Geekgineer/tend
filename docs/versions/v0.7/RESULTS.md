# v0.7 polish: results (2026-10-29, Claude Code 2.1.312, Node 26, macOS)

**Verdict: GO.** All 7 criteria met (criterion 2 amended: ⌘Esc leaves the terminal, because Claude Code owns
double-Esc). 316 tests pass; typecheck and `npm run check` are clean; no file over 600 lines.

| # | Criterion | Evidence |
|---|---|---|
| 1 | Palette | `test/unit/links-palette.test.ts` (fuzzy ranking); screenshot `shots/*-palette.png`; actions keep their confirms and look buttons up when run. |
| 2 | Focus rule | `termChord` unit test: ⌘⇧K / Ctrl⇧K palette, ⌘Esc leave; plain Esc, composing and repeats stay Claude's. |
| 3 | Smart links | URLs, loopback ports, changed files; only http(s) opens; OSC 8 confirms its real address; ranges mapped to cells. |
| 4 | Single instance | `test/e2e/cli.test.ts`: a second tend is refused with the running URL; a stale lock is taken over; the lock is removed on stop. The lock's nonce is answered on `/health`, so a reused pid can't fool it. |
| 5 | Rotate token | e2e: the new key works, the old one is 401 within ~1 s (file watch, no signals); open streams are closed. |
| 6 | Compatibility | `test/unit/compat.test.ts` (fake claude -p: pass, verified list persists; a missing hook is named). **Real self-test on 2.1.312: pass** (isolated: local setting source only, no MCP, secret hook path, only the test command allowed). |
| 7 | Quality | Opus review (6 Important, 6 Low) fixed in `7579e97`, scoped re-review. |
