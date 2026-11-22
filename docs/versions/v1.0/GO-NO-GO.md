# v1.0: go/no-go criteria

From the playbook: "All acceptance scenarios, conformance suite green on the installed Claude Code, packaging
works from a clean dir."

| # | Criterion | Evidence required |
|---|---|---|
| 1 | **Acceptance scenarios** (spec §18) each met, or honestly marked partial with what's missing. | ACCEPTANCE.md |
| 2 | **Conformance on the installed Claude Code:** the self-test passes on the installed version, and the real-claude smoke runs of every version pass on the final code. | Script output |
| 3 | **Packaging from a clean folder:** `npm pack` → install into an empty folder → `tend` runs from node_modules (compiled), serves the page, starts a session, and its status line wrapper reports. The package ships no source or tests. | `scripts/smoke/package.mjs` |
| 4 | **Load:** 20 sessions under a steady event stream: no event lost, keystroke round trip < 100 ms, memory levels off. | `scripts/perf/load.mjs` |
| 5 | **Quality:** check/typecheck/tests green; a final whole-product review with no open Critical/Important. | Command output + review |
