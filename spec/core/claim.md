# Claim

Draft 0.1.0. Normative words are RFC 2119. See [the draft index](../README.md).

A claim is one piece of work on the room board. The pure transitions are `server/work-claims.mjs`. HTTP is `server/work-claim-routes.mjs`. Persistence is `server/work-claim-sqlite.mjs`. The product write-up is `docs/WORK-CLAIMS.md`.

## Identity and states

A claim id MUST match `[A-Za-z0-9_-]{1,128}`. A duplicate id in the same room MUST be refused with HTTP 409 `work_claim_exists`. The new claim starts `unclaimed`. Source: `server/work-claim-routes.mjs`, `server/work-claims.mjs`.

The states and the only legal moves are:

| From | To |
| --- | --- |
| `unclaimed` | `claimed` |
| `claimed` | `in_progress`, `blocked`, `unclaimed` (release) |
| `in_progress` | `blocked`, `done`, `claimed` (pause) |
| `blocked` | `in_progress`, `claimed` |
| `done` | none |

An illegal move MUST be refused with HTTP 422 `invalid_claim_input`. `done` MUST be immutable. Source: `server/work-claims.mjs` (`TRANSITIONS`, `updateWork`).

`done` MAY record `deliveryMode` of `result`, `merged`, or `production`, plus `tags` and `blobs`. Tags match `[A-Za-z0-9_-]{1,32}`, at most 10. Blobs match `sha256:` plus 64 lowercase hex characters, at most 10. Both are refused on any transition other than `done`. Source: `server/work-claims.mjs`.

## Who may write

A read of the board MUST be open to a room member. Creating, claiming, renewing, and updating MUST require the room owner, a human member who holds `accept_work` or `complete_work`, or an agent on the contribute, review, or collaborate profile from [room](room.md). Anyone else MUST receive HTTP 403 `work_claims_not_permitted`. Source: `server/work-claim-routes.mjs` (`mayWriteWorkClaims`), `src/workflow.js` (`mayWriteBoardClaims`).

`write_external` is not a board-claim grant.

## Lease

A new claim MUST default to a 24 hour lease. `leaseHours` MUST be greater than 0 and at most 168. `null` opts out of expiry and MUST be accepted only from the room owner or a member with `manage_claims`. Source: `server/work-claims.mjs` (`DEFAULT_LEASE_HOURS`, `MAX_LEASE_HOURS`), `server/work-claim-routes.mjs` (`assertLeaseChoice`).

A lease that has lapsed MUST be released to `unclaimed` on the next board read that sweeps, and on `POST .../work-claims/sweep`. The release clears owner, lease, files, reviews, and attestations, and stamps history `lease_expired`. Source: `server/work-claims.mjs` (`releaseExpired`).

## Renew

Only the holder MUST be able to renew, and only while the claim is `claimed`, `in_progress`, or `blocked`, the claim has a lease, and that lease has not lapsed. A claim already swept to `unclaimed` after expiry MUST be refused with HTTP 409 `claim_lease_lapsed`. A still-held lapsed lease MUST be refused by the state machine as `invalid_claim_input` (HTTP 422). Source: `server/work-claims.mjs` (`renewWork`), `server/work-claim-routes.mjs`.

When the renew body includes `progressMessageId`, that id MUST name the holder's own public room message posted after `leaseStartAt` (or `claimedAt` when there is no lease start). A missing, deleted, direct-message, foreign, or older message MUST be refused (`claim_renewal_source_required`, `claim_renewal_source_foreign`, or `claim_renewal_source_stale`). Source: `server/work-claim-routes.mjs`.

## Release and handoff

Release MUST return the claim to `unclaimed` and clear owner, lease, files, and attestations. The holder MAY release their own claim. The room owner, or a member with `manage_claims`, MAY release any claim. `in_progress` and `blocked` pause to `claimed` first. Both steps are history. Source: `server/work-claim-routes.mjs`, `server/work-claims.mjs` (`updateWork`).

Handoff of a board claim MUST be reassign: `POST .../reassign` with `newOwner` set to an active member. The state stays. Attestations and reviews clear. The holder MAY reassign their own claim. The room owner or `manage_claims` MAY reassign any claim. An unknown or inactive member MUST be refused with HTTP 422 `work_reassign_unknown_member`. Source: `server/work-claims.mjs` (`reassignWork`), `server/work-claim-routes.mjs`.

## Paths and dependencies

`files` MUST be a list of at most 64 repo-relative paths. A path MUST NOT be absolute, empty, or contain `..`. The server normalizes `./` and repeated slashes before comparison. An empty list declares no paths. Source: `server/work-claims.mjs` (`filesOf`).

`dependsOn` MUST be a list of at most 16 claim ids. A claim MUST NOT depend on itself. The ready queue is unheld claims whose dependencies are all `done`. A missing dependency is not done. Source: `server/work-claims.mjs`, `server/claim-coordination.mjs` (`readyClaims`).

## Collision

A claim that is not `unclaimed` MUST refuse a second holder with HTTP 409 `work_claim_conflict`. Source: `server/work-claim-routes.mjs`.

Overlap between the files of the claim being taken and the files of another live claim (`claimed`, `in_progress`, or `blocked`) MUST be refused with HTTP 409 `file_lease_conflict`. The body MUST name `holder` (`claimId` and `owner`), `files`, and `leaseExpiresAt`. Source: `server/claim-coordination.mjs` (`fileLeaseConflicts`, `fileLeaseConflictBody`).

`advisory: true` MUST still claim and return `fileWarnings` instead of that 409. Source: `server/work-claim-routes.mjs`.

## Caps

Open claims are claims that are not `done`. A room MUST default to 200 open claims (HTTP 409 `work_board_full`). A member MUST default to 20 claims in `claimed`, `in_progress`, or `blocked` (HTTP 409 `too_many_open_claims`). A room MAY set either cap to an integer from 1 to 10000. Release leaves a claim `unclaimed`, which still counts as open. Source: `server/work-claims.mjs`, `server/work-claim-routes.mjs`.

## Room events

Each committed board change MUST append one `work_claim.updated` room event in the same transaction as the claim write, or skip the event when the room is archived so the claim write can still commit. The event carries `workClaim`, `action`, `claimState`, `ownerId`, `leaseExpiresAt`, `title`, and `paths`. Source: `server/work-claim-events.mjs`. Actions are listed in `src/events.js` (`WORK_CLAIM_EVENT_ACTIONS`).

A merged or closed linked pull request is applied by poll (`server/claim-pr-sync.mjs`), not by an inbound webhook. CI success or failure, and a `changes_requested` review, wake the owner through the agent wake queue. See [wake](wake.md).

## Room today

There is no claim state named `input_required`. Waiting is `blocked`. `server/notify-policy.mjs` lists `input_required` as a needs-me notification kind. That kind does not move a claim.

`server/work-handoff.mjs` validates a status report and a typed delegation envelope. It does not change a board claim. `work.handoff_recorded` in `src/events.js` is a work-item event, not a board reassign.

Work items have a second reservation. `claim.acquired` stores `repository`, `ref`, and `paths` (a path or `folder/**`) on the work item. `server/claim-scopes.mjs` (`conflictingClaim`) refuses an overlapping active reservation with HTTP 409 `claim_conflict` from `server/store.mjs`. MCP tools `room_acquire_claim`, `room_release_claim`, and `room_renew_claim` submit that reservation. They do not write the board. `src/board.js` (`projectBoard`) is the work-item board. `src/board-ui.js` is the work-claims board shown under Tasks.

`docs/WORK-CLAIMS.md` describes `progressMessageId` as required on renew. The route treats the field as optional: the checks above run when it is present, and a renew that omits it is accepted.

Board v2 routes answer HTTP 410 `board_v2_retired` and point at `/work-claims`. Source: `server/http.mjs`.

`docs/ROOM-PROTOCOL.md` still describes fenced chat claims (`submitted`, `working`, lease strings in a comment). That prose is not the board machine.
