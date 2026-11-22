# Try tend. v0.1

v0.1 gives you one page with all your Claude Code sessions, their live state (working, needs you, idle, ended), a real terminal for each, and a macOS notification when one needs you.

## Start it
```bash
cd ~/agents-center/tend
npm install            # first time only
node bin/tend.mjs
```
It prints `tend. running at http://127.0.0.1:4977/?key=…`. Open that exact link; the key sets a cookie, so later visits to `http://127.0.0.1:4977/` work in the same browser.

Stop it with Ctrl+C. **Your sessions keep running** in tmux; start tend again and they're all back.

## What to try (about 10 minutes)
1. **New session:** click *New session*, paste a project folder (for example `~/work/some-repo`), and give it a name.
2. **First run in a folder:** Claude asks whether you trust the folder. Answer it in the terminal: arrow down, then Enter.
3. **Work normally:** type prompts in the terminal. Everything Claude Code does works there: slash commands, Shift+Tab modes, Esc to interrupt.
4. **Start 2–3 more sessions** in other folders, and watch the fleet strip and the *All sessions* list.
5. **Needs you:** give a session something that asks for permission. Your default mode is `auto`, which prompts rarely, so a quick way is to start Claude in a session with `/permissions` set to ask, or ask it a question that makes it use AskUserQuestion. The tile turns amber, the session moves to *For you*, and a macOS notification appears. Answer in its terminal.
6. **Restart:** Ctrl+C the server, run `node bin/tend.mjs` again, and reload. The same sessions and states come back.

## Not in v0.1 yet (coming in v0.2–v0.5)
Answering permissions from cards, briefings, worktrees, the files and diff panel, context and usage tracking, multiple accounts, focus windows.

## Good to know
- Everything stays on your machine (127.0.0.1 only, token required, no telemetry).
- Sessions run in a private tmux server (`tmux -L tend`), so they never mix with your own tmux. `tmux -L tend ls` lists them.
- Data lives in `~/.tend` (event log, settings, token).
- macOS may ask once to allow notifications from Script Editor or osascript.
