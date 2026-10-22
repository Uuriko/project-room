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
4. Once: consumed by the action it approves; a second use is refused.
5. Still valid: re-checked at use time. If the approver lost access or revoked
   it, or the resource moved past the approved version, it is refused.

A chat message that says "approved" is never one of these, whoever posts it.
Already-authorized actions get no extra approval step.

## Current state (agent draft queue, server/inbox-approval.mjs)

| Property | Today |
|---|---|
| Who | Holds: only human identities may approve, request edits or reject. |
| Once | Holds: approved and rejected are terminal. |
| What | Gap: `approve(proposalId)` takes no expected version. After a resubmit, a human who saw v1 can approve v2 (pinned by the probe). |
| When | Gap: no expiry on pending proposals or verdicts. |
| Still valid | Not in this module; depends on the caller's route auth. |

## Smallest next change (for review, not built)

`approve(proposalId, { by, expectedVersion })`: refuse with
`approval_version_changed` when it differs from the current version. Same for
reject and requestEdits. Then add `expiresAt` on the verdict path. Both reuse
existing fields; no new table.

## Probe

tests/human-approval-probe.test.js pins: agents cannot approve, verdicts are
one-use, and the version gap above. When the version check ships, flip the
last test to expect the refusal.
