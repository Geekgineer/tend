# Try tend. v0.7

## Start it
```bash
cd ~/agents-center/tend
node bin/tend.mjs
```

## What to try
1. **⌘K** (or **⌘⇧K** while typing in the terminal): jump to any session or run an action (New session, Show
   now, Today, Pace, Park everything, Attach, Files, Pause/Resume/Archive). Type a few letters, Enter.
2. **⌘Esc** in the terminal leaves it, so A / D / 1–9 card shortcuts work (plain Esc twice stays Claude's rewind).
3. **Links in the terminal:** URLs and `localhost:5173` open a tab; a file the session changed opens its diff.
4. **One tend at a time:** starting a second one says where the first is running.
5. **New link:** `node bin/tend.mjs rotate-token` prints a new link; within a second old links and open tabs stop working.
6. **After a Claude Code update** Tend shows a banner until you run the self-test (one tiny prompt).
