# v0.6 media: ledger

Execution: native, then one opus review (code + security), a fix wave, real-claude smoke.

## Rulings
- **Metadata is stripped in code** (JPEG APP1/APP13, PNG tEXt/zTXt/iTXt/eXIf/tIME): `sips` keeps metadata.
  Applied after conversion and again after downscaling.
- **Conversion with macOS `sips`** (HEIC/TIFF → JPEG, GIF → first frame PNG, downscale). Linux has no `sips`; those
  formats fail there with "Could not read that image" (PNG/JPEG/PDF/files still work). Parked for packaging.
- **Other files pass through** (any type except video, ≤ 25 MB), saved under a slugged name; served inline only for
  images and PDFs, everything else downloads; every response is sandboxed with nosniff.
- **The path is pasted, never submitted** (bracketed paste, then a space). The user finishes the prompt.
- **In place: `--add-dir ~/.tend/attachments/<id>`** at launch (new and resumed sessions). Sessions started before
  v0.6 don't have it; Claude asks once to read the file.
- **Files panel diffs only paths the session itself changed** (from git facts), against its base or HEAD.
- **Names use local time** (`20261029-1452-login-bug.png`), like the spec's example.

## Parked
- Markdown / HTML / dev-server previews, the outputs shelf, "copy block".
- Removing an attachment's path from the prompt from its chip (the prompt belongs to Claude's TUI).
- In-place attachments cleanup after 30 days (archive removes them).

## Reviews and fixes (`2e61c49` + follow-up)
- **High:** the untracked-file diff followed symlinks; now lstat, regular files only, realpath inside, ≤ 1 MB.
- **Orientation:** applied before stripping. HEIC photos: `sips` keeps the tag through conversion, so the same step
  turns them upright (not verified with a real phone HEIC; cost if wrong: a HEIC photo arrives sideways).
- **Paste:** text plus a generic "image.png" (copied cells/slides) stays a text paste for the terminal.
- Uploads: one at a time per session (a refused one is drained); a failed downscale leaves no original behind.
