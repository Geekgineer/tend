# v0.6 media: go/no-go criteria (written before the plan)

**Scope (strict):** spec §6.1 (screenshots, images, PDFs, files into a session) and the files/diff panel from §16.
**Not in scope:** previews of HTML/markdown/dev servers, smart links, ⌘K palette, light editing.

**Facts verified before writing this:** Phase 0: Claude 2.1.312 reads an image at `.tend/attachments/shot.png`
(excluded via `.git/info/exclude`) with no permission prompt. macOS `sips` converts HEIC/TIFF/GIF and downscales
(checked: 3000×1000 → 2000×666) but keeps metadata, so Tend strips EXIF/GPS itself.

| # | Criterion | Evidence required |
|---|---|---|
| 1 | **Upload.** `POST /api/sessions/:id/attachments` (UI token, raw body, `x-file-name`), at most 25 MB, type from the bytes (PNG, JPEG, GIF, WebP, HEIC/HEIF, TIFF, PDF; other files pass through as files). Video is refused with "Claude can't watch video". Paused or ended sessions are refused. | E2E |
| 2 | **Normalise.** HEIC/HEIF/TIFF → JPEG; GIF → its first frame as PNG; long edge > 2,000 px → downscaled, original kept next to it; **EXIF/GPS/XMP/IPTC stripped** from JPEG and PNG (verified by re-reading the file); PDFs and other files untouched. | Unit tests on generated files |
| 3 | **Where it lands.** Worktree sessions: `<worktree>/.tend/attachments/<ts>-<slug>.<ext>`, with `.tend/` added to the repo's `info/exclude` (local only; tracked files and `.gitignore` untouched). In-place sessions: `~/.tend/attachments/<id>/`, and new/resumed in-place sessions launch with `--add-dir` for it. Names are slugged; no path escapes the folder. | Unit + e2e |
| 4 | **Into the prompt.** The quoted path (relative in a worktree, absolute in place) is inserted at the cursor as a bracketed paste, followed by a space. Nothing is submitted. | E2E (fake claude sees the pasted text, no Enter) |
| 5 | **UI.** Paste (⌘V with an image or file on the clipboard), drop onto the terminal pane (overlay "Drop to attach to <name>") or onto a list row (attaches to that session), and an Attach button. A chip strip shows this session's attachments (thumbnail for images; click opens it). Each upload confirms "Attached <name>". | Screenshots + UI unit tests |
| 6 | **Lifecycle.** Archive deletes a session's attachments (the worktree goes; the in-place folder is removed). Attachments are never committed (`git status` stays clean). | E2E |
| 7 | **Files panel.** A "Files" toggle in the header lists the session's changed files (from git facts); clicking one shows its diff against the session base (worktree) or HEAD (in place), untracked files as all-added. Text only, capped at 2,000 lines, binary files say so. Paths are validated (no escaping the worktree). | E2E + screenshots |
| 8 | **Real smoke (haiku):** an attached PNG is described correctly ("red") with no permission prompt. | Script output |
| 9 | **Quality and security:** check/typecheck/tests green; no file over 600 lines; review + security review (path traversal, upload limits, type sniffing, XSS in diff and file names) with no open Critical/Important. | Reports |
