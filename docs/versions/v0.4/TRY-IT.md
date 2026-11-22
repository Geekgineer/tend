# Try tend. v0.4

v0.4 keeps everything from v0.3 and adds **awareness**: context per session and usage per account, straight from
Claude Code's own status line. Tend never reads your login or calls a usage API.

## Start it
```bash
cd ~/agents-center/tend
node bin/tend.mjs
```
Restart tend if it was running. **Start a new session** to see context and usage: sessions started before v0.4
don't have the status line wrapper.

## What to try (about 5 minutes)
1. **Usage pill.** Within a few seconds of starting a session, the top bar shows `5h ▬▬▬│ 12% · 3 h 40 min`.
   - The bar's colour is your **pace**: green plenty of room, grey on pace, amber running warm, red running hot.
   - The tick marks even pace: where you'd be if you spread use evenly over the 5 hours.
2. **Popover.** Click the pill: 5-hour and weekly bars, one sentence of projection ("At this pace you stay under
   it; resets at 16:40"), and the sessions using the most in the last 30 minutes (click one to open it).
3. **Context.** Give a session some work. The header shows `context 23% · 230k / 1M` and `cache warm · 58 min left`.
   - At 60% a small ring appears on the list row (amber from 70%, red above 85%).
   - At 80% the header says *auto-compact soon*.
4. **Cache warning.** If a session waits on you and its prompt cache goes cold within 3 minutes, the card says so,
   with how many tokens a late answer re-reads.
5. **Your own status line** still shows at the bottom of Claude's screen, exactly as before.
6. **Accounts** (only if you use more than one Claude login): folders like `~/.claude-work` appear as accounts.
   Log in once with `CLAUDE_CONFIG_DIR=~/.claude-work claude` → `/login`. New sessions go to the account with the
   most room unless you pick one in the New session dialog; each account gets its own pill.

## Good to know
- Usage shows for Pro and Max plans (Claude only reports it there).
- Numbers survive a restart, greyed with "as of" when no session of that account is reporting.
- One notification when an account's 5-hour pace turns hot, naming the heaviest session.

## Not in v0.4 yet
- Focus windows, quiet hours, interruption budget (v0.5)
- "Compact at next stop"
