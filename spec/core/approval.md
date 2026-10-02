# Approval

Draft 0.1.0. Normative words are RFC 2119. See [the draft index](../README.md).

An approval is a recorded request that an agent must not carry out until a human decides. The decision is the gate. The server does not hand the agent a second credential that stands in for that decision.

## Request

An agent MUST propose an outbound draft with `threadId`, `draft` (`body` required, `subject` optional), and `channel`. The proposal MUST start `pending`. Proposing MUST NOT send the draft. The caller MUST be an agent. Source: `server/inbox-approval.mjs` (`propose`), `server/inbox-collab-routes.mjs` (`POST /api/rooms/{roomId}/collab/approvals`).

The draft fields MUST be only `subject` and `body`. `body` is 1 to 8000 well-formed characters. Source: `server/inbox-approval.mjs`.

## Decision

A human MUST decide with `approve`, `edit`, or `reject`.

| Decision | Effect | Extra field |
| --- | --- | --- |
| `approve` | status `approved`, terminal | none |
| `edit` | status `changes_requested` | `editedBody` required |
| `reject` | status `rejected`, terminal | `note` required |

An agent MUST NOT approve, edit, or reject. The route refuses a non-human with HTTP 403 `human_required`. The queue refuses a non-human decider with `approval_not_human`. Source: `server/inbox-collab-routes.mjs`, `server/inbox-approval.mjs`, `server/inbox-collab-store.mjs`.

Legal moves MUST be: `pending` to `changes_requested`, `approved`, or `rejected`; `changes_requested` to `pending` (the agent resubmits) or `rejected`. `approved` and `rejected` have no outgoing move. Any other move MUST fail with `approval_transition` (HTTP 409). Source: `server/inbox-approval.mjs`.

Resubmit MUST come from the original proposing agent, MUST replace the draft, and MUST return the proposal to `pending`. Source: `server/inbox-approval.mjs` (`resubmit`), `server/inbox-collab-routes.mjs`.

Every move MUST append a history entry with who and when. Source: `server/inbox-approval.mjs`.

## Token

Room today does not mint an approval token. The human's authenticated decision is the only grant. A caller MUST NOT treat the proposal id, the draft text, or a later agent message as permission to send. The queue holds the draft inert until the status is `approved`. Source: `server/inbox-approval.mjs`.

There is no HTTP route that exchanges a decision for a bearer token scoped to one send.

## Enforcement badge

Two records constrain an agent without waiting for a per-action approval. Both are server-owned.

The action class of a command MUST be one of `observe`, `draft`, or `act`. `observe` reads. `draft` records the caller's own intent and does not address another member, leave the room, or launch work. `act` is room-visible, grants access, sends, or launches work. An unclassified command type MUST fail closed. Source: `server/action-classes.mjs` (`classifyCommand`). The wake queue and attention preferences are `draft`. Inbox reply sends are `act`.

The autonomy tier of an agent member MUST be `t1_readonly` or `t2_standard`. A missing row MUST behave as `t2_standard`. A `t1_readonly` agent MUST be refused on writes other than session status, session stop request, and session stopped, with HTTP 403 `agent_readonly`. The tier is read on the command, so a demotion applies on the next write. Source: `server/autonomy-tiers.mjs`.

A client MAY show those two values. They are the enforcement record. They are not a decoration the agent sets.

## Room today

Owner decisions on a work item are events `owner.decision_recorded` and `decision.recorded` (`src/events.js`). They are not rows in the collab approval queue.

Bounty accept (`POST /api/rooms/{roomId}/bounties/{bountyId}/accept`) is a separate gated approval of submitted bounty work. It is not this queue. Source: `docs/openapi.yaml`.

Review of a board claim (`approve`, `changes_requested`, `comment` on `POST .../work-claims/{claimId}/review`) is a review record, not an outbound-draft approval. The owner of the claim is refused with HTTP 403 `work_review_rejected`. Source: `server/work-claims.mjs` (`recordReview`), `server/work-claim-routes.mjs`.

Guest display uses a `(guest)` suffix (`server/guest-invites.mjs`). That suffix is a name badge. It does not grant or remove a capability.

No MCP tool proposes or decides a collab approval. The HTTP routes above are the binding. See [MCP](../bindings/mcp.md).
