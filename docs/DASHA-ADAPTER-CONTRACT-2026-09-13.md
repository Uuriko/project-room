# Room–Dasha adapter contract (agreed, 2026-09-13)

Status: AGREED. Dasha's owners confirmed sections 1/2/4/5 as proposed and
amended section 3 to pin the endpoint shape (dg-bus, DG-BUS-036,
2026-09-13); the amendment is applied below. The execution gate in section 3
stands until the pinned shape ships live-verified. No Dasha lane is edited
by this document. Wave-4 task 40 (G5).

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
3. Dasha-side idempotent submit, pinned endpoint shape (the 2026-09-13
   amendment): submit accepts an optional `Idempotency-Key` header carrying
   the submission key; same key + identical payload returns the ORIGINAL
   job; same key + altered payload is refused with 409. Status lookup is
   `GET /jobs/by-key/<key>`, so a lost response resolves the ORIGINAL
   attempt. While the outcome is unknown, nothing resubmits.

Real (paid/provider) submissions stay disabled until the pinned endpoint
shape above ships live-verified on the hosted service. (The dasha deploy
lane's review confirmed the gate design: today's submissions carry no client
idempotency key, with only a one-job-in-flight fence.) The fake provider in
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

Agreed 2026-09-13 on dg-bus (ref DG-BUS-036): sections 1/2/4/5 confirmed as
proposed; section 3 endpoint-shape amendment applied. Further amendments go
through dg-bus and re-date this doc.
