# v1.0: ledger

## Rulings
- **Build for installing** (`npm run build`, also on `npm pack`): Node won't strip TypeScript inside node_modules,
  so the package ships compiled `dist/src`. A checkout keeps running `src/*.ts` (even with a stale dist).
- **Not published.** `"private": true` stays; publishing is the user's call. An unrelated `tend` package exists on
  npm, so the README says `npm i -g ./tend-1.0.0.tgz`, never `npx tend`. A rename (e.g. a scoped name) is the user's
  decision before any publish.
- **Status line shim** (`~/.tend/bin/tend-statusline`, rewritten at every start): sessions' settings point at it,
  so `brew upgrade node` or moving the package doesn't break running sessions' status lines.

## Final review (opus) and fixes
- **I1:** a card settled by the following hook left the session in needs-you (and its held ping fired): settles
  now happen before the state is worked out; the test asserts idle.
- **I2:** a high-risk request behind another card made no state change, so no urgent notification: `hold` sends
  it; e2e test.
- **I3:** README `npx tend` would run an unrelated package: fixed instructions.
- **I4:** sessions hard-coded node's versioned path: the shim above.
- Minors: Resume refuses when the account folder is gone and warns when it must start a new conversation; held
  stuck/crashed pings are dropped once they no longer apply; attachment folders must resolve inside the session
  (symlinked `.tend` refused); PNG/JPEG attach without `sips` (Linux); README no longer overclaims.
