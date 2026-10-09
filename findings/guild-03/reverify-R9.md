# re-verify R9: wave500/presence-w4-delta
started: 2026-10-09T09:51:14Z
HEAD is now at c8028510c wave500 W4: pr-link tests — strip boardSeq on stored-vs-response compares (F3 storage envelope)
branch head: c8028510c, merge-base with origin/main: d73a42c5
slice files changed: server/work-claim-routes.mjs 
rebase: CLEAN onto 21d94657e
running affected suite: tests/work-claims-read.test.js tests/work-claim-sweep.test.js
suite: 2 passed, 0 failed
node --check on slice files:
done: 2026-10-09T09:52:50Z

## Adversarial review (2026-10-09)
Branch: origin/wave500/presence-w4-delta.
Rebase: CLEAN onto 21d94657e. Suite: 2 passed, 0 failed.
- Adds per-room monotonic boardSeq, ?since=N delta mode on the board list, strips boardSeq from non-board surfaces.
- R9-1 (HIGH — see R10 deep review): the feature is inert against the production store. boardSeq stamping and boardSeq() exist ONLY on the in-memory createWorkClaimRegistry; production uses the durable sqlite registry (store.mjs:1119 createDurableWorkClaimRegistry), which has zero boardSeq support. In production every page reports boardSeq: 0 and every ?since=N>=0 delta is permanently empty. Tests pass because they exercise the in-memory registry.
- R9-2 (minor): review route strips boardSeq on the duplicate path but NOT on the fresh `reviewed` path (line 1213) — inconsistent with the strip-everywhere-else discipline; boardSeq leaks on review responses.
- R9-3 (minor): ?since= validation uses 400 invalid_input while the module's query-param convention is 422.
- R9-4 (advisory): delta mode ignores the limit param (hasMore:false, all changed claims returned) — a busy board's delta is unbounded.
Verdict: R9-1 must be fixed before merge (port stamping to the durable registry); the rest is minor.
