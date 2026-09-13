# Room–Dasha adapter contract (proposal, 2026-09-13)

Status: PROPOSED. Agreement protocol at the bottom; this contract is not in
force until Dasha's owners confirm on dg-bus. No Dasha lane is edited by
this document. Wave-4 task 40 (G5).

## 1. Ownership

- The Room is the system of record for work: proposal, acceptance, session
  claims, results, review, and the event log. Work state lives nowhere else.
- Dasha executes. Dasha's adapter reports attempts and execution evidence
  into the Room and never owns or overrides work state.

## 2. Interfaces

Dasha's adapter uses existing Room primitives (mapping in
docs/DASHA-PROVIDER-COORDINATION.md):

| Concern | Interface |
|---|---|
| Provider joins / advertises capacity | agent member + capabilities registry |
| Provider liveness | presence roster + 10-minute session heartbeat lease |
| Job offered | work item (WORK_PROPOSED) |
| Job assigned, no double-booking | session claim (409 `session_claimed` on races) |
| Attempt accounting | G1 attempt fields on session start/stop: `environment`, `limits` (budget), `outputs` |
| Submission safety | G3 dispatch reconciliation (below) |
| Completion evidence | work-result payload (`evidenceKind`, `verifiedBy` convention) |

## 3. Submission reconciliation (required before any real execution)

Per docs/AGENT-BRIDGE-ACCEPTANCE-2026-09-07 AC-02, Room-side dedup alone is
insufficient. The adapter contract requires, per dispatch:

1. A stable submission key: `dasha:<workItemId>:<attempt>` (the G1 attempt
   number makes retries distinct attempts, not duplicate executions).
2. Intent persisted before submission (server/dispatch-journal.mjs or an
   equivalent Dasha-side durable record).
3. Dasha-side idempotent submit: repeated submit under the same key returns
   the same job; altered payload under the same key is refused.
4. Dasha-side status lookup by submission key, so a lost response resolves
   the ORIGINAL attempt. While the outcome is unknown, nothing resubmits.

Real (paid/provider) submissions stay disabled until the hosted service's
idempotency and status contract is verified. The fake provider in
server/dispatch-journal.mjs models the required behavior for tests.

## 4. Evidence Dasha reports

- On every stop: outcome (`done`/`failed`) plus `outputs` references
  (message ids, receipt ids, or URLs).
- Completion evidence lands as the work item's result; `verifiedBy` null is
  self-reported, set means a verifier member confirmed (the room's `verify`
  permission gates who can set it).

## 5. Explicitly out of scope

Billing and settlement (absent from the inspected kit), cancellation UX,
context-grant UX, MCP transport. Each is later work with its own task.

## 6. Agreement protocol

Dasha owners reply on dg-bus (ref DG-BUS-036) with confirm or amendments.
Amendments are applied here and the doc re-dated; the contract takes effect
on mutual confirmation.
