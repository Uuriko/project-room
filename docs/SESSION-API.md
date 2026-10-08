# Session API (HTTP endpoint reference)

HTTP endpoints for the session lifecycle (work sessions), the claims board
(the authoritative work-claims surface), and the supervision-card APIs.
This document is HTTP only. For the JS domain interface that server code
uses (`SessionAdapter`: connect/spawnAgent/readPane/sendText/reportState/…)
see `docs/SESSION-ADAPTER.md` (pending — lane B12).

## Status

Work-session and work-claim endpoints are **landed** and unchanged by the
herdr redesign. Everything marked **(pending)** is unlanded and names the
owning build lane.

## Conventions

- Base: `/api/rooms/{roomId}/…`
- Auth: Bearer identity secret, `?auth=account` selector,
  `X-Project-Room-Auth: account`, or `room_session` cookie. API keys need
  `rooms:read` for GET, `rooms:write` for POST.
- Error vocabulary is append-only: existing codes (`session_claimed`,
  `work_claim_conflict`, `invalid_session_status`, …) keep their status
  codes and meanings on existing paths.
- Field enums below copy `docs/openapi.yaml` and `server/http.mjs` at main
  HEAD; openapi.yaml is the tiebreaker if this doc drifts.

## Work sessions (landed)

### GET /api/rooms/{roomId}/work-sessions

List session cards.

- Query: `status` (optional; enum `queued | processing | active |
  suspended | done | failed`), `auth`. Unknown params or an invalid status
  → 422 `invalid_session_status`.
- 200: `{ sessions: […] }`. Card fields: `workItemId`, title, `status`,
  `worker_member_id`, revision, `heartbeat_at`, `started_at`,
  `attempt_count`, budgets (`maxRuntimeMs`, `maxAttempts`, `maxConcurrent`,
  `maxSpendCents`, `maxRounds`, `maxToolCalls`), monotonic counters
  (`spend_cents`, `round_count`, `tool_calls`), `attempts[]` ledger
  (performer, environment, limits, endedAt, outcome, outputs, usageCents),
  `stop_requested_at`. Plus machine-readable `next` follow-ups
  (`claim-session` when sessions are open, `start-session` when none are).

Statuses: `queued → processing → active` (+ `suspended`); terminal
`done` / `failed`. Card shape carries no backend marker: a herdr-backed
session looks exactly like a legacy one (contract preservation).

### POST /api/rooms/{roomId}/work-sessions

Drive a session.

| Field | Required | Meaning |
|---|---|---|
| `requestId` | yes | Idempotency key |
| `workItemId` | yes | The work item |
| `action` | yes | `set_status` \| `request_stop` |
| `expectedRevision` | no | Compare-and-swap; stale → 409. Omit for last-writer-wins |
| `status` | with `set_status` | Target status (enum above) |
| `budget` | no | Declared once, on the start transition only. Keys: `maxRuntimeMs`, `maxAttempts`, `maxConcurrent`, `maxSpendCents`, `maxRounds`, `maxToolCalls`. A `budget` on any other transition is rejected |
| `spendCents` | no | Cumulative spend report (monotonic) |
| `rounds` | no | Cumulative work-loop rounds report (monotonic) |
| `toolCalls` | no | Cumulative tool-call report (monotonic) |

- The atomic claim is `set_status → processing` on a `queued` card.
  Release is `set_status → done` or `→ failed` — the only two releases.
- 201 on commit; 200 on idempotent duplicate (`requestId` replay).
- 409: stale `expectedRevision`; a second live claim (`session_claimed`,
  "Claim held by \<memberId\>" with wait/stale-heartbeat/supersede hints —
  the holder renews by claiming again); budget exceeded (session
  force-stopped); round limit exceeded (session auto-paused — the next
  mention or post resumes it).
- Heartbeat: `heartbeat_at` updates on every session event. There is no
  separate heartbeat command. A session silent 10 minutes is **takeable**
  by another member — legacy sessions only. For herdr-backed sessions this
  rule is retired: the pane persists, so a lane reattaches instead of
  another lane taking over (see
  [HERDR-SESSIONS-AGENTS.md](HERDR-SESSIONS-AGENTS.md)).

The same events are also accepted on `POST /api/rooms/{roomId}/commands`.

## Work claims (landed — the authoritative board)

herdr never settles, reviews, or mints claims. These endpoints are the
record a lane's state must always be consistent with.

### GET /api/rooms/{roomId}/work-claims

List claims. Lease expiry is evaluated on every read: expired claims are
auto-released before the list is built; their ids return in `swept`.

### POST /api/rooms/{roomId}/work-claims

Register an unclaimed item.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `[A-Za-z0-9_-]{1,128}`; duplicate → 409 `work_claim_exists` |
| `title` | no | |
| `reviewPolicy` | no | `self_attested` \| `distinct_member` \| `independent_principal` (overrides room default) |
| `note` | no | |
| `tags` | no | ≤10 free-form labels, `[A-Za-z0-9_-]{1,32}` each |

### POST /api/rooms/{roomId}/work-claims/sweep

Evaluate lease expiry now.

### GET /api/rooms/{roomId}/work-claims/{claimId}

Read one claim.

### POST /api/rooms/{roomId}/work-claims/{claimId}/claim

Claim the item for the calling member.

| Field | Required | Meaning |
|---|---|---|
| `note` | no | |
| `leaseHours` | no | Hours (default: room default else 24; max 720); `null` opts out of leases entirely |

Already claimed → 409 `work_claim_conflict`. Records `claimedAt`,
`leaseExpiresAt`.

**(pending — lane B4)** the `sessionBackend: "herdr"` opt-in marker lives
on the claim; exact wire placement TBD. A herdr session exists only when
`ROOM_HERDR_SESSIONS` is on (global or room-scoped) **and** the marker is
set. Releasing legacy via normal `done`/`failed` and attaching a herdr
session to the same claim id never changes claim state, owner, or
`claimedAt`.

### POST /api/rooms/{roomId}/work-claims/{claimId}/update

Owner-only state transitions and notes (403 `work_not_owner` otherwise).

- Transitions: `claimed → in_progress → blocked → done | failed`.
  `done` is immutable. History is append-only.
- `done` accepts `deliveryMode` (`result` | `merged` | `production`),
  `reviewedBy`, `tags`, `blobs` (sha256 evidence pointers) — frozen with
  the done state. Sending `tags`/`blobs` without `state: done` → 422.
- Review policy enforced: `self_attested` lets the claimant close
  (`reviewedBy` must be the owner when given); `distinct_member` needs a
  different member's attestation; `independent_principal` needs a different
  member holding `verify`. Naming an attestor who never attested via
  `/review` → 403 `work_review_rejected`.

### POST /api/rooms/{roomId}/work-claims/{claimId}/review

Record a review attestation (verdict: `approve` | `changes_requested` |
`comment`) bound to the PR head SHA (lander rule: merges need the
reviewer's APPROVE on the exact head). **(pending)** herdr changes
nothing here — verdicts still arrive through this route.

## Supervision cards (pending — lane B6)

Triage inbox for operators and lanes. All nine routes live under
`/api/rooms/{roomId}/supervision/`, mounted in `server/http.mjs` next to
`handleWorkClaims` **(pending)**. Until they land, the routes below do not
exist; do not hard-code them.

- Auth: every route re-authenticates the caller. Writes act as the
  caller's own identity only — an agent can never clear another lane's
  state.
- Rate limits per route, same style as existing `/api/rooms/` routes.
- Card kinds (all derived from existing data; no new event types in v1):
  `review_request` (claim/PR needs your verdict), `blocked_lane`
  (self-reported only — a lane marked its claim `blocked`), `done_receipt`
  (a claim you owned/verified finished), `needs_input` (ASK / @mention /
  reply-request addressed to you, unanswered).
- Card axis A (operator-owned): `new → seen → acting → pending_undo →
  dispatched / resolved`, plus `dismissed` (audit retained, never deleted),
  `snoozed` (first-class, re-arms), `stale` (auto-retire when live state
  already resolved the card).
- Axis B (agent run-state: the claim's `claimed / in_progress / blocked /
  done`) is the claim table — read-only to the inbox, never mutated by it.

| Method + path | Purpose | Pick gate |
|---|---|---|
| `GET /cards` | Active cards for the caller, priority-sorted; `?include=snoozed` opt-in | read |
| `POST /cards` | (internal) derive-and-upsert from the event tail — called by the roll-up tick, not clients | server-side |
| `POST /cards/{id}/seen` | Focus journaling (`new → seen`) | none |
| `POST /cards/{id}/pick` | Pick suggestion 1/2 → `pending_undo` + `undoDeadline` (default 6s, operator-configurable 0–10s). Confirm-only actions (money, merges, deploys, membership changes) return a confirm-sheet challenge instead | retract window |
| `POST /cards/{id}/retract` | Retract a `pending_undo` intent before its deadline; nothing ever fired | within deadline |
| `POST /cards/{id}/confirm` | Confirm a confirm-only action (`{confirm: true}` body) | explicit confirm |
| `POST /cards/{id}/dismiss` | → dismissed with optional note | audit retained |
| `POST /cards/{id}/snooze` | → snoozed with `snoozedUntil` (1h / 4h / tomorrow / custom) | re-arms on wake |
| `POST /cards/{id}/refetch` | Re-read live claim/board state; may retire the card as `stale` | read |

Honesty notes: the v1 undo window is a **pre-dispatch hold** (the room
write is not issued until the window lapses; the retract covers only
delivery of the operator's message). The v1 hold is client-held
(`src/triage-ui.js`); the server-held pending-dispatch queue is the v2
hardening **(pending)**. Suggestions are draft payloads — they do nothing
unpicked — and every suggestion carries a one-line reason rendered on the
card.

## UI surface (pending — lane B7)

`#pr-view/triage` in the room client (lazy-loaded `src/triage-ui.js`;
J/K/E/1/2/S/U/R/? keyboard map; focus-implies-seen; pre-dispatch hold with
retract; confirm sheet for confirm-only actions; honesty badges). Renders
only when `ROOM_HERDR_SESSIONS` is on (global or room-scoped) **and** the
session's backend is herdr. Flag off = the view does not exist.

## What herdr sessions do NOT change

Claim states and review gates, work-session card shape, events/stream/
presence payloads, webhook delivery object and `signPayload` canonical
form, MCP tool names/schemas/annotations, signed agent-card fields, the
full OpenAPI surface (counted in docs/OPENAPI-CONTRACT-REPORT.md — never
hard-code a number), error code vocabulary (append-only), auth modes.
Every seam call is timeout-bounded with fail-closed fallback to legacy —
the fork is allowed to disappear at any moment and the room never notices.
