# v1.2: Elsewhere (sessions outside tend) and Adopt

From the design's "Later" list (§16), and the v1 promise in §19.1 that external sessions show as list rows. Tend now lists Claude sessions started outside it and can take one over after you close it.

## How it works
- **Listing.** `claude agents --json` runs once per account (Claude config folder), at most every 4 s, and only while a page is open on *All sessions*. One call takes about 0.13 s.
  - Tend's own sessions are left out.
  - Every entry is validated: a UUID session id, an absolute folder, and a known kind.
- **Closed.** A session counts as closed when it leaves the listing *and* its process is gone. Tend checks the process with signal 0, which only probes and delivers nothing.
  - A failed listing never marks anything closed.
  - A row that leaves the listing while its pid lingers (a reused pid, a supervisor) is forgotten after 60 s, never marked closed.
  - Closed sessions are remembered for 12 h, in memory, and hidden once their folder is gone (finished test runs).
- **Writes nothing.** `claude agents --json` was checked against a marker file: three runs changed nothing in `~/.claude` or `~/.claude.json`.
- **Adopt** (`POST /api/external/adopt`) re-checks against a fresh listing and refuses when:
  - the session is still open;
  - tend already runs it;
  - its folder is gone;
  - Claude saved no conversation for it.

  Otherwise it starts a normal tend session **in place** with `--resume=<id>` under the same account, because the transcript belongs to that folder.
- **What tend never does.** It never signals, stops or types into a session it didn't start. The "close it first" rule is what keeps two Claude processes from writing one conversation.

## Go / no-go
| Criterion | Evidence |
|---|---|
| Outside sessions listed, own sessions excluded, bad entries dropped | `test/unit/external.test.ts` (11 tests) |
| Adopt refused while open, without a transcript, twice, and for a bad id; token required | `test/e2e/external.test.ts` |
| Adopted launch uses `--resume=<id>`, in place, same account | `test/e2e/external.test.ts` (argv read back) |
| Real browser: rows render, the open session has no Adopt, Adopt selects the new session, no page errors, light and dark | `scripts/probe/elsewhere.mjs` |
| **Real Claude**: a haiku session started outside tend, in a temp folder, is listed. Adopt is refused while it's open. After `/exit` it's adopted and **remembers the word from its first turn**. Hooks drive tend's state. | `scripts/probe/adopt-real.mjs`: ok, 8 steps |
| No regressions | 355/355 tests (10 of them new), browser journey 19/19, 60 fast switches with 0 page errors, `check` clean |

The real-Claude probe first "failed": its first prompt was never submitted, and tend correctly refused to adopt a session with no conversation. The probe now waits for Claude's own reply line.

## Limits
- Tend only knows a session closed if it saw it open. A session closed while tend wasn't running, or before you opened *All sessions*, isn't offered. Claude's own `claude --resume` still works for those.
- If you reopen an adopted conversation outside tend with `claude --resume` while tend runs it, nothing stops that.
- Product code is now about 10.3K lines, against the spec's 8K target. No single file is over 600 lines.

## Review
The independent reviewer stalled and was stopped, so I checked its questions by hand:
- **Auth:** both routes sit in the route table with token auth and the same Origin/Host checks as every `/api` route.
- **Untrusted fields:** an outside session's name is stripped of control characters and reaches tmux as an escaped argv element, never through a shell. In the UI, every field is escaped.
- **Hardening made:** the name is now passed as one `--name=<value>` argument, so a name starting with `-` can never be read as a Claude flag. There's a unit test, and the real-Claude adopt probe passes with it.
- **Adopts** are serialized with a module-level flag. Each one re-reads a fresh listing and re-checks tend's own sessions after that await.

Tests: 357/357 on three consecutive runs. One earlier run had a single failure that didn't recur and wasn't identified.

**Verdict:** go.
