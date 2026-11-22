# Try tend. v0.6

v0.6 keeps everything from v0.5 and adds **media**: give Claude screenshots, images, PDFs and files without
leaving Tend, and see every file a session changed.

## Start it
```bash
cd ~/agents-center/tend
node bin/tend.mjs
```
Restart tend if it was running. Start a new session (in-place sessions need it for attachments).

## What to try (about 5 minutes)
1. **Paste a screenshot.** ⌘⇧⌃4, select an area (it goes to the clipboard), click in Tend and press ⌘V.
   - "Attached screenshot-….png" appears, and the quoted path is typed at Claude's prompt. Nothing is sent: finish
     your question ("what's wrong in this screenshot?") and press Enter.
2. **Drop a file** from Finder onto the terminal ("Drop to attach to …"), or onto a session in the list to attach it
   to that session without switching.
3. **Attach** (above the terminal) opens a file picker. Chips show this session's attachments; click one to open it.
4. **Files · N** (above the terminal) lists what the session changed; click a file for its diff.

## Good to know
- Images are converted when needed (HEIC → JPEG), shrunk past 2,000 px (the original is kept), and their location
  and camera data are removed.
- Files land in the session's worktree under `.tend/attachments/` (never committed: Tend adds `.tend/` to the repo's
  local exclude list), or under `~/.tend/attachments/` for in-place sessions. Archive removes them.
- Video isn't supported: Claude can't watch it. Attach a screenshot instead.

## Not in v0.6 yet
- ⌘K palette, clickable paths and links in the terminal (v0.7)
