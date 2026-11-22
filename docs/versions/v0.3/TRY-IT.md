# Try tend. v0.3

v0.3 keeps everything from v0.2 and adds **decision cards**: answer Claude's permission requests, questions
and plan approvals from Tend, without opening the terminal.

## Start it
```bash
cd ~/agents-center/tend
node bin/tend.mjs
```
Open the printed `http://127.0.0.1:4977/?key=…` link. Restart tend if it was running, so it loads the new code.
Sessions started before v0.3 keep their old hooks; start a new session to try the cards.

## What to try (about 10 minutes)
Claude only asks when its permission mode asks. If your default mode is `auto`, most safe actions won't ask
at all (that's good). To see cards quickly, press Shift+Tab in the terminal until it says **manual mode**, or
start a session in a scratch repo.

1. **A permission.** Ask Claude to run something that changes files, for example `mkdir tend-try`.
   - The session moves to *For you → Waiting on you*; the row says **Wants to run mkdir tend-try**.
   - The card above the briefing shows the command, a **risk label** and the rule behind it.
   - Click **Allow** (or press **A** once the terminal isn't focused). Claude's own dialog closes and it runs.
2. **Deny with a note.** Ask for another change, type a note ("use the tmp folder instead") and click **Deny**.
   Claude gets your note.
3. **High risk.** Ask Claude to run `git push --force` in a scratch repo (it will ask).
   - The card says **High risk · Force push**. **Allow…** needs a second click (**Confirm allow**) within 5 s.
   - No keyboard shortcut and no "Always allow" on high-risk cards.
4. **A question.** Ask: *"Use AskUserQuestion to ask me red or blue."* Pick an option on the card
   (or press **1** / **2**). Claude continues with your answer.
5. **A plan.** Shift+Tab into plan mode, ask for a small change, and click **Approve plan** on the card.
6. **Answer in the terminal instead.** Both stay usable: answer in Claude's dialog and the card goes away by
   itself. A card answered too late does nothing.
7. **Restart tend** while a card is showing. After the restart the card says *Claude is waiting for you in the
   terminal*: answer there. Tend never answers anything by itself.

## Good to know
- **Risk rules** are plain rules, not AI. Add your own in `~/.tend/risk-rules.json`:
  `[{ "level": "high", "rule": "Deploys", "pattern": "\\bfly deploy\\b" }]`.
- **"Always allow"** only appears when Claude itself offers it (for example "allow edits this session").
- **Multi-select questions** say *answer in the terminal*.
- The terminal keeps the keyboard while it's focused: click outside it to use A / D / 1–9.

## Not in v0.3 yet
- Context-window and usage tracking per account (v0.4)
- Focus windows and quiet hours (v0.5)
- Files/diff panel, image drop
