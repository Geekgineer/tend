# v0.5 calm: ledger

Execution: native, then one opus review covering code and security, a fix wave.

## Rulings
- **Focus windows are on by default (25 min).** The spec calls them the Tend promise. Cost if wrong: a user who
  wants every notification at once turns them off in Pace; the inbox always shows everything meanwhile.
- **Urgent = high-risk permission, stuck, crashed** (spec §22). They skip the focus window but not quiet hours or the
  hourly budget (the spec says quiet hours hold "the rest"; we read it as everything, and say so when they end).
- **A focus window starts with its first held item**, so an item waits at most N minutes; one held item per session
  (the latest says enough); at release, a held "needs you" whose session no longer needs you is dropped.
- **Held items live in memory.** A restart drops them; the inbox still shows every session's state.
  Cost if wrong: a held notification is lost on restart (never an answer, only a ping).
- **Stuck** follows spec §9 exactly; the card shows the repeated error verbatim and no "likely cause".
- **Crashed** = the pane died without SessionEnd and Tend wasn't stopping it (Pause/Archive mark `stopping`).
  Rebuilt after a restart from the last lifecycle event.
- **Park everything** types one message (bracketed paste + Enter) into *working* sessions only, after a confirm.
- **Wrap-up** comes from the event log and the notices table; "turns finished" counts Claude's Stop events.
- **Tests** run with focus windows off unless they opt in (`TEND_FOCUS=1`), so earlier versions' notification tests
  keep their meaning.

## Parked
- Per-project mute; daily wrap-up at a chosen time (shown on demand in Today instead).
- "Since you left" uses the wrap-up of the away period; tomorrow's start-of-day briefing after Park is not built.
