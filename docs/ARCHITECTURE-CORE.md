# Project Room — Server Core Architecture

WAVE-400 docs-core. Covers the server core partition at origin/main
`c5d1c313a`: the HTTP/MCP surface, the work-claim system, the RoomStore, and
room lifecycle/export. Per-module detail lives in
[docs/wave400-core/modules/](wave400-core/modules/).

Note: `server/event*.mjs` and `server/db*.mjs` do not exist in the tree —
the partition names them, but there is nothing there.

## Module map

| Module | One line |
|---|---|
| `server/http.mjs` (5005 lines) | The monolithic HTTP server: route table, auth preamble, room-scoped funnel, family dispatches. |
| `server/store.mjs` (5256 lines) | `RoomStore`: SQLite-backed event-sourced room state; constructs ~60 sub-stores; owns transactions, schema, integrity. |
| `server/work-claims.mjs` | Pure claim state machine: unclaimed→claimed→in_progress→blocked→done/closed, leases, compare-and-release. |
| `server/work-claim-routes.mjs` | HTTP routes for the board: 17 handlers, auth layers, error semantics. |
| `server/work-claim-sqlite.mjs` | Durable claim registry on SQLite (`work_claims`, `work_claim_config`). |
| `server/work-claim-events.mjs` | One thin `work_claim.updated` room event per committed claim change; wake fan-out; event-budget coalescing. |
| `server/work-claim-mirror.mjs` | Projection→board translator: projection claim events become board operations. |
| `server/work-claim-integrity.mjs` | Board input guards: text normalization, lease bounds, PR input allowlisting, event-budget refusal. |
| `server/claim-coordination.mjs` | Pure helpers: PR settlement, file-lease exclusivity, dependency readiness, poll scheduling. |
| `server/public-work-claims.mjs` | Public surface: unpaid offers strangers can claim/work/submit, request-id idempotent. |
| `server/public-work-claim-fence.mjs` | SQLite write-permit fence for public claim writes (not auth). |
| `server/mcp-http.mjs` | Streamable HTTP MCP transport: anonymous join surface + authenticated room profile. |
| `server/mcp-room-profile.mjs` | Authenticated MCP profile: 107 tools, writes through `RoomStore.command`. |
| `server/messages-store.mjs` | `messages` table double-written with the event log; budgeted backfill + parity certification. |
| `server/room-lifecycle.mjs` | Room create/archive, `archived_at` derived column, account-room creation gate. |
| `server/room-context.mjs` | Pure read projection with sha256 `context_version` (`not_modified` protocol). |
| `server/room-guide.mjs` | Deterministic demo agent, inert after first real assignment. |
| `server/room-export.mjs` / `room-export-html.mjs` | NDJSON whole-DB backup + inverse replay; self-contained HTML export. |
| `server/room-attachment-bytes.mjs` | Attachment BLOB staging in sqlite; base64-in-JSON serving. |
| `server/agent-rooms.mjs` / `server/public-rooms.mjs` | Agent room provisioning; public room surfaces. |
| `server/room-directory.mjs` | Room directory listing. |
| `server/room-activation-pack.mjs` | Activation packs for new members. |
| `server/room-assistant.mjs` | Room assistant configuration. |
| `server/room-key-presence.mjs` | Key-presence tracking via agent heartbeats. |
| `server/room-flood-guard.mjs` | Burst/refill rate limiter for room writes. |

## Data flow

```
HTTP/MCP request
  → http.mjs: route table → auth preamble (credential, fence, rate-limit, API-key scope)
  → family dispatch (work-claims, matchmaking, feedback, bounties, …)
  → work-claim-routes.mjs: handleWorkClaims — validation (work-claim-integrity),
      access checks, lease sweep, state machine (work-claims.mjs)
  → RoomStore.transaction: claim registry write (work-claim-sqlite.mjs)
      + work_claim.updated room event (work-claim-events.mjs) — atomic
  → projection update → stored back to rooms.projection
  → wake fan-out (enqueueClaimWake) + receipt cards
```

Reads: `store.room(roomId)` replays the event log into a projection (cached by
`ProjectionCache`); `messages` table serves indexed reads; the projection is
the authority during migration.

Writes: `RoomStore.command` validates the command shape (`COMMAND_TYPES`),
applies the event, appends the row, updates the projection — all in one
SQLite transaction (BEGIN IMMEDIATE; WAL; busy_timeout=3000).

## Claim lifecycle

```
unclaimed ──claim──▶ claimed ──(work)──▶ in_progress ──done──▶ done
    ▲                    │  ├──blocked──▶ blocked ──(unblock)──▶ in_progress
    │                    │  ├──release/expire──▶ unclaimed
    │                    │  └──PR merged──▶ done (deliveryMode merged)
    │                    │  └──PR closed──▶ unclaimed
    └──readyClaims: unclaimed + all dependsOn done → eligible
```

Lease: `claimedAt` + `leaseHours` → `leaseExpiresAt`. Expired leases are
swept to unclaimed (`lease_expired` stamp). `renewWork` extends; `null`
leaseHours opts out (route-gated). Compare-and-release (`expectedClaimedAt`
+ `expectedHistoryLength`) guards stale writers on PR-link append.

## Key invariants

- **The database is the truth; events are notifications.** The `work_claims`
  table is the source of truth; room events carry pointers.
- **One claim change → one room event**, in the same transaction (claim and
  event commit or roll back together).
- **Event budget**: <10% of the room's lifetime event budget → board writes
  limited to owner/manage_claims (`409 room_event_budget_low`).
- **Schema versions are a contiguous range** 0..STORE_SCHEMA_VERSION — never
  a hand-maintained list (a dropped version once 500'd rooms).
- **Retired tables stay**: `board_vtwo_*` are never dropped; recovery audit
  still sees them.
- **Pure where it matters**: `work-claims.mjs`, `claim-coordination.mjs`,
  `room-context.mjs` do no I/O; every transition returns a new frozen item.
- **Request IDs are idempotency keys** on the public surface: same id + same
  input replays; same id + different input → 409.
- **Wake/receipt failures never roll back claims.**
