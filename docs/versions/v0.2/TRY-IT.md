# Try tend. v0.2

v0.2 keeps everything from v0.1 (one page for all sessions, live terminals, "needs you" notifications) and adds:
- **Memory:** a briefing for every session.
- **Git facts:** branch, commits and uncommitted changes, shown live.
- **A worktree per session**, so parallel sessions can't step on each other.
- **Overlap warnings.**
- **Pause, Resume and Archive.**

## Start it
```bash
cd ~/agents-center/tend
git checkout main      # v0.2 is merged there
node bin/tend.mjs
```
Open the printed `http://127.0.0.1:4977/?key=…` link.

## What to try (about 15 minutes)
1. **New session in a git repo.**
   - Pick a repo folder. Leave **Own worktree** ticked: the hint shows the branch it will create (`tend/<name>-xxxx`).
   - Claude starts in `~/.tend/worktrees/<id>`, in the same subfolder you picked.
   - Your main checkout is untouched. If it has uncommitted changes, tend tells you they aren't in the worktree.
2. **Trust.**
   - The first time Claude meets a repo, it asks "Do you trust this folder?". The session now shows as **needs you · asks you to trust the folder**, with a notification. Answer it in the terminal.
   - Claude remembers trust per repo, so later sessions in that repo don't ask again. A repo you've already used Claude in never asks.
3. **Briefing.**
   - Give it a task, then come back later and open the session.
   - The **Briefing** panel above the terminal shows:
     - **Goal:** your first prompt.
     - **Done:** what each turn finished, with the files it touched.
     - **Your instructions.**
     - **Files edited.**
   - It uses no AI tokens; it's built from the session's own events.
   - Collapse it with the chevron, and tend remembers the choice.
4. **Git facts.** The header line shows the branch, `↑n` (commits since the session started), uncommitted changes and `worktree` / `in place`. It refreshes as Claude works.
5. **Overlap.** Start two sessions in the same repo and ask both to edit the same file. Both get an amber **Overlaps …** chip, they move to *For you → Problems*, and you get one notification for the pair. Nothing is blocked.
6. **Pause → Resume.**
   - **Pause** stops Claude and saves the work as one WIP commit on the session's branch.
   - It also sets ignored files such as `.env` and `node_modules` aside in `~/.tend/paused/<id>`, then removes the worktree to free the folder.
   - **Resume** puts everything back exactly as it was and continues the **same Claude conversation**. Ask it what you talked about.
7. **Resume an ended session.** Quit Claude (`/exit`) or let it crash. **Resume** restarts it in the same folder with the same conversation.
8. **Archive.** This removes the session from the list and frees its worktree. The branch `tend/…` stays, so nothing is lost.
9. **Restart tend** (Ctrl+C, run it again). Briefings, git facts, paused sessions and overlaps all come back, and no notifications are repeated.

## Good to know
- **Worktrees start clean:** no `node_modules`, no `.env`. Install or copy what the project needs, or untick *Own worktree* to run in the folder itself.
- **Staging isn't kept across a pause:** after Resume, your changes are all back but unstaged.
- **Tend never pushes, and never deletes your branches.** The WIP commit made by Pause is undone by Resume. After an Archive it stays on the `tend/…` branch.
- **In-place sessions can't be paused,** because there's no worktree to free. Resume still works for them after they end.
- **Your data stays on your machine.** It lives in `~/.tend`, and nothing leaves your machine.

## Not in v0.2 yet
- Answering permissions and questions from cards (v0.3)
- Context-window and usage tracking per account (v0.4)
- Focus windows and quiet hours (v0.5)
- The files/diff panel and image drop
