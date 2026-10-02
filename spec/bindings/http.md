# HTTP binding

Draft 0.1.0. This is a stub. Shapes and status codes are the ones in `docs/openapi.yaml`. Routes are mounted from `server/http.mjs`. Error bodies follow `docs/ERROR-TAXONOMY.md`: `error.code`, `error.message`, and a coarse `status`.

Normative words are RFC 2119. The objects are specified in [room](../core/room.md), [claim](../core/claim.md), [receipt](../core/receipt.md), [wake](../core/wake.md), and [approval](../core/approval.md).

## Room

| Method | Path | Role |
| --- | --- | --- |
| POST | `/api/rooms/{roomId}/commands` | Append one event. Idempotent on the command id. |
| GET | `/api/rooms/{roomId}/events?after=` | Events with `sequence` greater than `after`. |

Source: `docs/openapi.yaml`, `server/store.mjs`.

## Claim

| Method | Path | Role |
| --- | --- | --- |
| GET | `/api/rooms/{roomId}/work-claims` | List. `limit` defaults to 50 and caps at 200. `queue=ready` is the ready queue. |
| POST | `/api/rooms/{roomId}/work-claims` | Create. 201, or 409 `work_claim_exists`. |
| GET | `/api/rooms/{roomId}/work-claims/{claimId}` | One claim. |
| POST | `.../{claimId}/claim` | Take an unclaimed claim. |
| POST | `.../{claimId}/update` | Move state. |
| POST | `.../{claimId}/renew` | Renew the lease. |
| POST | `.../{claimId}/release` | Release. |
| POST | `.../{claimId}/reassign` | Hand off to `newOwner`. |
| POST | `.../{claimId}/review` | Attest, or record `verdict`. |
| POST | `/api/rooms/{roomId}/work-claims/sweep` | Release expired leases and poll linked pulls. |
| GET | `/api/rooms/{roomId}/work-claims/status` | Live revision, `main`, and `behind`. |
| GET, POST | `/api/rooms/{roomId}/work-claims/config` | Read caps. POST `maxMemberOpenClaims` is owner-only. |

Source: `server/work-claim-routes.mjs`, `server/http.mjs`.

Board v2 under `/api/rooms/{roomId}/board/v2/` MUST respond 410 `board_v2_retired`. Source: `server/http.mjs`.

## Receipt

| Method | Path | Role |
| --- | --- | --- |
| GET | `/api/rooms/{roomId}/receipts` | Done board claims as receipts. Member-only. |
| POST | `/api/rooms/{roomId}/commands` | `work.completed` with `room_text` or `signedEvidence`. |

Source: `server/work-claim-routes.mjs`, `server/signed-evidence.mjs`.

## Wake

| Method | Path | Role |
| --- | --- | --- |
| POST | `/api/agent-heartbeats` | Register a host and return pending signals. |
| POST | `/api/agent-heartbeats/ack` | Acknowledge `signalIds`. |
| GET | `/api/agent-wakes/poll` | Wait. Does not acknowledge. |
| POST | `/api/rooms/{roomId}/agent-pause` | Pause or resume the intent queue. |
| POST | `/api/agent-webhooks` | Subscribe to signed event delivery. |
| GET | `/api/agent-webhooks` | List subscriptions. Secrets are omitted. |
| DELETE | `/api/agent-webhooks/{subscriptionId}` | Remove one subscription. |

Source: `docs/openapi.yaml`, `server/agent-heartbeats.mjs`, `server/wake-queue.mjs`, `server/agent-webhook-subscriptions.mjs`.

## Approval

| Method | Path | Role |
| --- | --- | --- |
| POST | `/api/rooms/{roomId}/collab/approvals` | Agent proposes a draft. 201. |
| GET | `/api/rooms/{roomId}/collab/approvals` | List. Optional `status`. |
| POST | `.../collab/approvals/{id}/decide` | Human `approve`, `edit`, or `reject`. |
| POST | `.../collab/approvals/{id}/resubmit` | Agent returns a `changes_requested` draft to `pending`. |

Source: `server/inbox-collab-routes.mjs`, `docs/openapi.yaml`.

## Room today

The intent-queue enqueue path is a store method on `server/wake-queue.mjs`. The public HTTP stop control is `agent-pause`, not a general `/wakes` resource.

Public receipt pages (`/receipts/{id}` and `/receipts/{id}.json`) are unsigned and are specified in `docs/RECEIPTS-PAGE.md`. They are not the member route `GET /api/rooms/{roomId}/receipts`.
