# Session command policy — local implementation checkpoint

Date: 2026-09-12. Branch: `codex/project-room-identity-scope`.
Parent: `45beb1c` (identity relink repair), based on `ff7365e`.
Canonical shared checkout and Grok's MCP/G2 files were not edited.
Not deployed, published, merged, or independently approved.

## Change

Live session policy now runs at the common command boundary, rather than relying
on callers to use the dedicated work-session endpoint. Both HTTP routes use it.

- Starts and continuing status changes respect the member's recorded halt.
- A live worker's session cannot be taken over without claim-management authority.
- Starts and takeovers respect the tightest declared concurrency cap among the
  acquired session and the new worker's other active sessions. Claim management
  is not an exemption from budget policy.
- Runtime and reported-spend excess deny further continuation, including a
  successful completion. Failed cleanup remains possible for authorized actors.
- Start budgets are validated and attempt limits checked at the common boundary.
- Public commands cannot manufacture `budgetEnforced`, `reason`, or `limit`
  metadata on stop events. Internal enforcement uses a private method.
- Dedicated runtime/spend enforcement authenticates before inspecting state.
  Failed stop persistence propagates failure instead of claiming the stop worked.
- Duplicate worker/concurrency checks were removed from the dedicated endpoint.

No event-schema, migration, historical reducer, or replay changes were made.

## Verification

`node --test tests/session-command-policy.test.js tests/work-item-session.test.js tests/work-session-budget.test.js tests/handoff-receipt.test.js`

Result: 21 passed, zero failed/skipped. Seven new HTTP regression cases cover
generic-command bypasses, loose-cap declarations, worker ownership, cap-limited
takeovers through both routes, runtime and reported spend, forged enforcement
facts, halt-all, and injected SQLite stop-write failure. Positive controls verify
cleanup, exact spend threshold, authorized takeover, and slot reuse.

The new takeover regression failed before its fix: a capped claim manager got
HTTP 201 rather than 409. After the fix both routes reject the takeover and leave
the original worker unchanged; releasing the occupied slot permits takeover.

`git diff --check` passed. `node scripts/check.mjs` passed: 1,147 tests,
zero failed/cancelled/skipped, test duration 23,059 ms.

SHA-256:

- `server/store.mjs`: `d423630b909999276c011c62838d1f4d63f30beac4a5533e1d65265e3c5790df`
- `tests/session-command-policy.test.js`: `d5d79693a71277be782e75434861f2e37bedbb458f8614ef6ff1ed449caed9ba`

## Limits and next review

This closes specific command-entry bypasses, not the complete execution-budget
problem. Runtime checks occur on interaction; they do not terminate an external
process. Spend is client-reported, not verified provider billing. Generic commands
reject excess continuation; only the dedicated endpoint records the automatic
failed stop. These different side effects must not be described as a hard runner
or financial limit.

Review next: spend monotonicity and reporting semantics; start-event spend fields;
exact retries after budget expiry; stale-worker takeover cases; durable runner
cancellation and acknowledgments; alternate runtime parity; independent G2 tests.
An already stopped external worker is not proved by a stored terminal event.

Grok retains the independent `tests/session-policy-boundary.test.js` assignment.
Compare that evidence before integration. Product readiness, operational recovery,
physical-device usability, and real-user qualification remain open.
