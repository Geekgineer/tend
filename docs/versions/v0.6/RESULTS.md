# v0.6 media: results (2026-10-29, Claude Code 2.1.312, tmux 3.8, Node 26, macOS)

**Verdict: GO.** All 9 criteria met. 307 tests pass; typecheck and `npm run check` are clean; no file over 600
lines. The real-claude smoke (`scripts/smoke/media.mjs`, haiku) passes on the final code: an attached PNG was
described as "Red" with no permission prompt.

| # | Criterion | Evidence |
|---|---|---|
| 1 | Upload | e2e: 201 with name/kind/insert; video refused ("can't watch video"); > 25 MB → 413; one upload at a time per session. |
| 2 | Normalise | `test/unit/attachments.test.ts`: types from bytes; JPEG APP1/APP13 and PNG text chunks stripped (re-read); 3000 px → 2000 px with the original in `originals/`; phone photos turned upright from EXIF Orientation before stripping; WebP/HEIC/TIFF → JPEG via `sips` (async). |
| 3 | Where it lands | e2e: worktree `.tend/attachments/…` with `.tend/` in the repo's `info/exclude`; in place `~/.tend/attachments/<id>` with `--add-dir` at launch. |
| 4 | Into the prompt | e2e: the quoted path appears at the prompt; nothing was submitted (the session never went to working). |
| 5 | UI | Attach, paste (files only, never into text fields or for text-with-picture pastes), drop on the pane and on list rows, chips with thumbnails. Screenshots `shots/*-attachments.png`, `*-files.png`; `test/unit/media-ui.test.ts`. |
| 6 | Lifecycle | e2e: archive removes the in-place folder; the worktree's `git status` stays clean. |
| 7 | Files panel | e2e: a modified file and a new file show their diffs; an untracked symlink shows its target only; paths outside the session's changed list → 404; literal pathspecs. |
| 8 | Real smoke | "Red", no permission card. |
| 9 | Quality and security | Opus review (code + security): 1 High (untracked diff followed symlinks), 2 Important, 4 Medium, minors — fixed in `2e61c49`, scoped re-review. |
