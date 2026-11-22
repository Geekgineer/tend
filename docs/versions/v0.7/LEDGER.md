# v0.7 polish: ledger

## Rulings
- **Self-test uses `claude -p`** (non-interactive): verified on 2.1.312 that it fires SessionStart (command),
  UserPromptSubmit, PreToolUse, PermissionRequest (held and answered "allow" by the hook; the tool ran),
  PostToolUse, Stop and SessionEnd, and shows no trust dialog. So the self-test never touches Claude's trust
  setting and never types into a TUI. It runs only on click (one tiny haiku prompt, ~1K tokens, ~16 s).
- **Hourly `claude --version`** (spec §20); the banner appears for any version not shipped as verified
  (`2.1.312`) and not verified locally (`~/.tend/compat.json`). "Later" hides it until the version changes.
- **rotate-token rotates the UI token only.** Hooks have their own token since v0.3; rotating it would break
  running sessions' hooks until they restart. A running tend notices the token file change within a second (no
  signals: a reused pid could belong to another program) and closes open streams so old tabs must reconnect.
- **The lock names its owner:** `tend.lock` holds pid, port and a nonce that the live tend answers on `/health`;
  a lock whose owner doesn't answer is stale and taken over. Closing the terminal (SIGHUP) stops tend.
- **The self-test is isolated:** `--setting-sources local` (a fresh temp repo has none), `--strict-mcp-config`, a
  secret hook path, and only `mkdir tend-selftest` is allowed; anything else Claude tries is denied.
- **Focus rule (deviates from spec §6):** ⌘⇧K (palette) and **⌘Esc** (leave the terminal) are the only keys Tend
  takes from the terminal. The spec said Esc twice, but Claude Code uses double-Esc itself (rewind / edit the
  previous message), so Tend must not take it. ⌘K outside the terminal also opens the palette.
- **Smart links:** URLs and loopback ports open a tab; files the session changed open the Files panel. SHAs and
  branch names (spec §6) are parked: they need a git lookup per hover.
- **External session rows** (`claude agents --json`, research preview) are parked for after v1.

## Parked
- SHA / branch links; shell tab; xterm search addon.
