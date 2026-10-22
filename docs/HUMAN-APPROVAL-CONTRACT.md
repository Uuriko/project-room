# Human approval contract (proposal, not implemented)

2026-10-21. Status: contract and probe only. No runtime change, no new key,
no new auth path. Authority stays with the existing session and member checks
(coordinate with Jill on authority). Approval UI integration belongs to the
implementation owner (muse-room 17323).

## Goal

When an agent needs its person's approval, the receiving agent can check that
the approval came from that person, for this exact action, and was not
relayed, replayed or stale. Today such approvals are often relayed in chat
("Potter approved"), which agents correctly refuse.

## What counts as a verifiable approval

An approval is a service record, not a message. It is valid only if all hold:

1. Who: recorded by an authenticated human member session through existing
   authority. An agent identity can never record one. A device or app label is
   display only, never proof.
2. What: bound to one action kind, one resource id, and the exact version the
   human was shown (draft version, request revision, work revision, or commit).
3. When: has an expiry; an expired approval is refused, not reused.
4. Once: consumed by the action it approves; a second use is refused
   (target; not implemented anywhere today).
5. Still valid: re-checked at use time. If the approver lost access or revoked
   it, or the resource moved past the approved version, it is refused.

A chat message that says "approved" is never one of these, whoever posts it.
Already-authorized actions get no extra approval step.

## Current state (agent draft queue, server/inbox-approval.mjs)

Scope: this section covers only the inert agent-draft approval queue. It is not
a general action-approval protocol, and nothing here is complete for other
actions.

| Property | Today |
|---|---|
| Who | Holds through the authenticated route (caller identity from auth), not from the `by` object alone. Only human members may approve, request edits or reject; an agent gets 403. Not established: binding the approver to a particular agent's owner. |
| Terminal verdict | Holds: approved and rejected are terminal; a second verdict is refused (409). |
| Once (consumed by the action) | Not implemented. The module has no consume or use operation, and an approved record stays readable and reusable. |
| What | Gap: `approve(proposalId)` takes no expected version (an `expectedVersion` input is refused today with 422). After a resubmit, a human who saw v1 can approve v2 (pinned by the probe). |
| When | Gap: no expiry. There is no `expiresAt` on proposals or verdicts. |
| Still valid at use | Not established: no consume-time revocation or version check. |
| Device proof | Not established, and not proposed: a device label is display only. |

## Smallest next change (for review, not built)

1. Version binding: `approve(proposalId, { by, expectedVersion })` refuses with
   `approval_version_changed` when it differs from the current version; same
   for reject and requestEdits. Needs the route to accept the field.
2. Expiry and consumption are larger: they need a new field on the route
   shape, a persisted operation with replay behavior, and compatibility with
   existing rows. Design those separately before code.

## Probe

tests/human-approval-probe.test.js pins: agents cannot approve, verdicts are
terminal, and the version gap above. When the version check ships, flip the
last test to expect the refusal. An independent real-HTTP check of the same
points is recorded at muse-room 17329.
