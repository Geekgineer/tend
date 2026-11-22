# Try tend. v0.5

v0.5 keeps everything from v0.4 and adds **calm**: fewer interruptions, a pace you can keep, and a clear view of
what needs you.

## Start it
```bash
cd ~/agents-center/tend
node bin/tend.mjs
```
Restart tend if it was running.

## What to try (about 10 minutes)
1. **Focus windows (on by default, every 25 min).**
   - A normal permission or question no longer pings you at once. The top bar shows **2 held · Show now**.
   - Hover it for who's waiting and when the next batch arrives; click **Show now** to get them now.
   - High-risk requests, stuck sessions and crashes still notify immediately.
   - The list always shows everything; only notifications wait.
2. **Pace** (top bar): turn focus windows off, change the minutes, set **quiet hours** (nothing notifies; one
   summary when they end), the most notifications per hour, and your **soft limit** on sessions at once.
3. **Soft limit.** Start more sessions than your limit: the New session dialog says so gently. Nothing is blocked.
4. **Stuck.** A session that hits the same error three times in 15 minutes (or goes 10 minutes silent while
   working) moves to *For you → Problems* with the error shown word for word.
5. **Crashed.** If a session's process dies on its own, it's marked *Ended unexpectedly* (notified at once);
   **Resume** continues the same conversation. Pause, Archive and `/exit` are not crashes.
6. **Today** (top bar): decisions made, turns finished, sessions started, commits, interruptions sent and held, and
   how long sessions waited on you.
7. **Park everything** (in Today): after a confirm, asks every working session to finish its current step and stop.
8. **Since you left.** Come back to the tab after 5+ minutes: one line says what happened meanwhile.

## Good to know
- Settings live in `~/.tend/settings.json`.
- Held notifications are kept in memory; restarting tend drops them (the list still shows everything).

## Not in v0.5 yet
- Files/diff panel, image drop, ⌘K palette
