# v0.7 polish: go/no-go criteria (written before the plan)

**Scope (strict):** the remaining v1 items from spec §6, §19.7 and §20 that need no new data source:
a ⌘K palette, smart links in the terminal, a single-instance lock, `tend rotate-token`, and the Claude Code
compatibility check. **Not in scope:** external (non-Tend) session rows (research-preview CLI), AI summaries,
previews, packaging (v1.0).

| # | Criterion | Evidence required |
|---|---|---|
| 1 | **Palette.** ⌘K (outside the terminal) or ⌘⇧K (anywhere, including the terminal) opens a palette: jump to any session (name, folder, state), and run actions (New session, Show now, Today, Pace, Park everything, Attach, Files, Resume/Pause/Archive the selected session). Type to filter (fuzzy), ↑↓ Enter to run, Esc to close. Destructive actions keep their own confirm. | UI unit tests + screenshot |
| 2 | **Focus rule.** With the terminal focused every key goes to Claude except ⌘⇧K and Esc pressed twice within 500 ms (leaves the terminal). | UI unit test |
| 3 | **Smart links.** In the terminal, `http(s)://` URLs and `localhost:PORT` open in a new tab (loopback only for bare ports); OSC 8 hyperlinks open the same way; a path the session changed opens the Files panel at that file. Nothing else becomes a link, and links never run commands. | UI unit tests |
| 4 | **Single instance.** A second `tend` on the same home exits with "tend is already running at http://127.0.0.1:<port>/" (lock file with the pid in `~/.tend/tend.lock`); a stale lock (dead pid) is taken over. | E2E (CLI) |
| 5 | **Rotate token.** `tend rotate-token` writes a new UI token (old links stop working) and prints the new link; hooks keep their own token so running sessions keep working. | E2E (CLI) |
| 6 | **Compatibility.** At startup and hourly Tend records `claude --version`. A version not in the tested list (shipped + locally verified) shows one banner: "Claude Code X hasn't been checked with Tend yet" with **Run self-test** (one tiny haiku prompt in a temp repo: hook events arrive with the expected fields, a held permission is answered, a stop arrives; ~1K tokens; only on click). A passing self-test adds the version to `~/.tend/compat.json`; a failure names what's missing and says cards fall back to the terminal. | Unit tests + a real self-test run |
| 7 | **Quality.** check/typecheck/tests green; no file over 600 lines; a review with no open Critical/Important. | Command output + review |
