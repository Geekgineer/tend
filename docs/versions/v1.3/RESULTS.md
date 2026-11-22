# v1.3: install in one line

Goal: a developer goes from zero to tend running with as little as possible.

## What changed
- **npm package `tend-cc`** (the name `tend` belongs to another package). `npx tend-cc` tries it; `npm i -g tend-cc`
  installs the `tend` command. Both `tend` and `tend-cc` are commands, so `npx tend-cc` always finds its executable.
- **Opens the browser** on start when run from a terminal. Never from scripts or pipes; `--no-open` or
  `TEND_NO_OPEN=1` turn it off.
- **`tend doctor`** checks Node 24+, tmux and Claude Code (`claude --version`), with the fix for anything missing.
- **`tend --help`, `tend --version`**, and an unknown command points to `--help`.
- **Friendlier first run:** Node older than 24 gets a clear message before anything loads; missing tmux or Claude
  Code says how to install it and suggests `tend doctor`.
- **MIT license**, package metadata (repository, homepage, keywords), README install section, npm badge.

## Evidence
| Check | Result |
|---|---|
| Full suite | 359/359 (1 new CLI test: version, help, doctor sick and healthy, unknown command, nothing started) |
| `scripts/smoke/package.mjs` | PASS: pack, install into an empty folder, page, vendor files, a session, status line wrapper |
| `npm exec --package=<tarball> -- tend-cc --version` / `doctor` | 1.3.0 / "All set" |
| Global install into a temp prefix, `tend --help` | ok |
| Package size | about 136 KB packed, 74 files; no src/, test/ or docs/ |
| `check`, `typecheck` | clean |
