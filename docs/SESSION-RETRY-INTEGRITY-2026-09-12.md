# Session retry integrity

Local follow-up to `9fefe6e`, isolated `codex/project-room-identity-scope`.
No canonical edits, deployment, or integration.

## Evidence and repair

Two new regressions failed before the repair:

1. Repeating an accepted start request after runtime expiry recorded a failed
   stop instead of returning the original event.
2. Reusing the request ID with a different budget returned success rather than
   an idempotency conflict.

Accepted requests are now resolved after authentication but before the budget
trip-wire. Matching covers the complete translated event payload: work item,
revision, action/status, budget, and reported spend. Changed payloads conflict
without writing events, even after runtime expiry. Both transaction boundaries
retain the duplicate check. No persistence format or replay change is required.

Explicit null start budgets remain equivalent to no budget, matching existing
start normalization. A retry returns a historical result, not a renewed lease:
it cannot refresh heartbeat, extend runtime, or acknowledge current execution.
A new interaction still triggers the existing budget policy.

## Verification

22 focused tests pass with zero failures/skips. The regressions assert unchanged
event sequence and session state, not just response codes. Existing runtime-trip
coverage now uses a controlled clock: a real one-millisecond timing assumption
failed during this run despite a new request ID, and was removed.

`node scripts/check.mjs`: 1,149 passed, zero failed/cancelled/skipped; test
duration 23,415 ms. `git diff --check` also passed.

## Still open

Spend remains client-reported and its monotonicity/start-event behavior needs
further work. Interaction-based policy does not stop an external process or prove
financial enforcement. Independent G2 review and runtime parity qualification
remain outstanding. This checkpoint does not establish product readiness.
