# Project Room ↔ machine protocol — canonical contract

**Status:** canonical as of 2026-10-13 (simplification program, decision 18 / issue #3217). This document is the single contract the machine + relay extraction will version against when `machine/` and `relay/` leave this repo. It describes the protocol **as implemented today**; where an older document disagrees with this one, this one wins, and where this document and the code disagree, the code wins and this document is the bug.

It replaces, as the canonical statement, the overlapping descriptions previously spread across `machine/PROTOCOL.md` (daemon wire contract), `relay/PROTOCOL.md` (relay operator notes), `machine/lib/protocol.mjs`, and `relay/src/protocol.mjs`. Those files remain as implementation-local notes until extraction; their protocol constants are pinned by §6.

## Parties

- **Room (core)** — the Project Room server (`server/`), served canonically by the Cloudflare Worker + Durable Object at `https://room.trydemigod.com`.
- **Machine daemon** — `machine/` (CLI + daemon + bot loop) running on an operator's macOS host. A *client* of Room: at runtime it imports nothing from core and speaks only the HTTP surface in §2 plus, when a relay is configured, the relay link in §3.
- **Relay** — `relay/`, a separate Worker (`project-room-relay`). A bridge between Room and daemons that cannot or should not hold a direct Room session. **The relay is undeployed today** (its README: "off until someone deploys it"); phase-0 passthrough is the only working mode (§4).

## 1. Enrollment and identity

1. An operator mints a Room **agent invite** (`profile: "contribute"`) in the room the machine will join, and stores that invite code on a relay enroll record via `POST /admin/enroll-codes` (`Authorization: Bearer <RELAY_ADMIN_TOKEN>`; body: `label`, `roomId` or `rooms` (1..8), `ownerMemberId`, `inviteCode`, optional `displayName`, `roomOrigin`).
2. The daemon calls `POST {relay}/v0/enroll` with `{ "code": "<machineId>.<verifier>" }`. The code is single-use and expires **15 minutes** after minting. `200` returns `machineToken`, `machineId`, `label`, `roomId`, `ownerMemberId`, `inviteCode`, `displayName`, `relayUrl` (`wss://<host>/v0/machines/link`, derived from the host that served the enroll), and optional `roomOrigin` (daemon falls back to `ROOM_ORIGIN`, then `https://room.trydemigod.com`). Errors: `401 code_invalid`, `410 code_used` / `code_expired`. (`POST /enroll` is the same handler with `Deprecation: true`, kept for one release.)
3. The relay stores only the SHA-256 of the machine token; the token is returned once, is sent only as `Authorization: Bearer` on the socket upgrade, and is never a query parameter.
4. The daemon creates **its own Room identity**: proof-of-work on `POST /api/agent-identities` (`machine/lib/room.mjs` `mintIdentity` / `solveIdentityProof`), then redeems the invite with `POST /api/agent-invites/redeem`. Neither the relay nor Room creates the identity for it. The enroll code must not be consumed before the identity + redeem path is durably completable — burning the single-use code on a late failure is defect #2875 (fix in flight, PR #3142); resumable enroll is part of this contract.
5. The daemon is inert unless `ROOM_MACHINE_ENABLED` is exactly `1` **and** its config `enabled` is true. `stop` and `uninstall` still run when the flag is off.

## 2. Direct Room HTTP surface (daemon → Room, no relay)

The daemon authenticates with its identity secret (`Authorization: Bearer <secret>`). This is the complete Room surface the machine product depends on; extraction must not widen it without a contract revision.

| Purpose | Call | Used by |
| --- | --- | --- |
| Mint identity (proof-of-work) | `POST /api/agent-identities` | `machine/lib/room.mjs` |
| Redeem invite | `POST /api/agent-invites/redeem` | `machine/lib/room.mjs` |
| Heartbeat (host registration) | `POST /api/agent-heartbeats` (hostId `room-machine`) | `lib/room.mjs`, `bot/room-api.mjs` |
| Wake long-poll | `GET /api/agent-wakes/poll?hostId=room-machine&waitMs=<ms>` | `bot/room-api.mjs` |
| Wake ack | `POST /api/agent-heartbeats/ack` | `bot/room-api.mjs` |
| Orientation | `GET /api/rooms/:roomId/orient` | `bot/room-api.mjs` |
| Room updates feed | `GET /api/rooms/:roomId/updates?…`; `POST /api/rooms/:roomId/updates/:itemId/:action` | `bot/room-api.mjs` |
| Conversation read | `GET /api/rooms/:roomId/conversation?…` | `bot/room-api.mjs` |
| Post message / commands | `POST /api/rooms/:roomId/commands` | `lib/room.mjs`, `bot/room-api.mjs` |
| Event pages (approval polling) | `GET /api/rooms/:roomId/events?after=<seq>&limit=100` | `lib/room.mjs` |
| Stage a file | `POST /api/rooms/:roomId/files` | `lib/room.mjs` |
| Work claims (desk/scratch leases are claims) | `GET /api/rooms/:roomId/work-claims?limit=200`; `GET …/work-claims/:claimId`; `POST …/work-claims`; `POST …/work-claims/:claimId/claim`; `POST …/work-claims/:claimId/update` | `bot/room-api.mjs`, `lib/room.mjs` |
| Pause / operator state | `GET /api/rooms/:roomId/agent-pause`; `GET /api/rooms/:roomId/operator/agents/:memberId` | `bot/room-api.mjs` |

A **desk lease is an ordinary work claim** whose `files` entry is `resource/<machineId>/desk`; a scratch lease uses `resource/<machineId>/scratch`. There is no `kind: "lease"` claim. `machine.release` (§3) closes the claim through this surface; if the machine identity does not own the claim, Room returns `403` and the release reports `closed: false`.

**Approvals ride this surface too:** for gated tool classes (§3), the daemon posts `approve <code>` as a room message and accepts one exact reply `approve <code>` from `ownerMemberId` within 10 minutes, once, polling the events feed above.

## 3. Relay link (daemon ↔ relay, WebSocket)

Socket: daemon connects to `relayUrl` with `Authorization: Bearer <machineToken>` on the upgrade. Frames are JSON text; call ids match `[A-Za-z0-9_-]{1,64}`; a result frame is at most **4 MiB** (4,194,304 bytes); a call frame at most **1 MiB**.

- Daemon → relay: `{ "type": "hello", "protocol": 1, "machineId", "label", "version" }` after upgrade. A second connection for the same machine closes the previous socket with code `4001` (`replaced`); calls in flight on the old socket fail `409 link_replaced`.
- Relay → daemon control frames: `heartbeat` (on connect and ~every 30 s), `halt` (`{ "epoch": <number> }`), `pause` (`{ "minutes": 1..10080 }`; 0 is refused — the daemon ignores a duration-less pause), `resume`, `bye`. On `hello`, the relay replays the current `halt`, or a `pause` with remaining minutes rounded up; an offline `resume` is not replayed.
- Relay → daemon call: `{ "type": "call", "id", "tool", "args", "caller": { "identityId", "claimId", "slot", "verified": true } }`. `verified` is exactly `true` and is set only after the relay's own phase-0 check (§4) succeeds. Slots are `desk` and `scratch`.
- Daemon → relay: `{ "type": "result", "id", "ok": true, "result" }` or `{ "type": "result", "id", "ok": false, "error": { "code", "message" } }`. **Every started call must produce a result frame** — a swallowed exception that leaves the caller hanging is defect #2873 (fix in flight, PR #3140). A tool failure is a normal result (`isError: true` at the MCP layer), not a transport error.
- Calls are handled one at a time, but control frames are applied as they arrive, even mid-call; a call that waited (e.g. on owner approval) re-checks halt/pause/dead-man before dispatching.
- Dead-man: no inbound relay message for `ROOM_MACHINE_DEADMAN_SECONDS` (default **120**) suspends guests and refuses calls with `deadman` until a later heartbeat or hello. Reconnect uses backoff (`reconnectBackoffMs`, default 1000).

### Tools

Default allowlist: `machine.status`, `machine.release`, `desktop.screenshot`, `desktop.click`, `desktop.type`, `desktop.key`, `desktop.scroll`, `desktop.list_apps`, `shell.vm`, `files.put`, `files.get`, `inference.chat`. A name outside the allowlist is refused (`tool_denied` daemon-side; `403 tool_not_allowed` relay-side) and never dispatched. There is no host shell tool: `shell.vm` runs inside the guest via `lume ssh`, output capped at 64 KiB (`output_capped`), default timeout 30 s. `files.*` operate on `/Users/lume/room-scratch` in the guest, single path segment, 8 MiB cap. Room files are at most 1 MiB. `machine.release` returns `{ "blobs": ["sha256:…"], "tags": […], "closed": bool }` — at most 10 blobs (1 manifest + up to 9 keyframes); tags match `[A-Za-z0-9_-]{1,32}`.

Approval-gated classes (wait for the owner per §2): `egress.new_domain`, `desk.restore`, `credential.use`, `files.export_large` (`files.get` > 1 MiB), `shell.desk`.

Error codes: `lease_required`, `slot_held`, `tool_denied`, `deadman`, `halted`, `paused`, `disabled`, `too_large`, `timeout`, `output_capped`, `guest_limit`, `approval_required`, `approval_denied`, `unavailable`, `invalid_message`, `not_granted`.

The relay also exposes the link over MCP (`/.well-known/oauth-protected-resource/v0/machines/<machineId>/mcp`; MCP protocol `2025-11-25`, also accepts `2025-06-18`, `2025-03-26`) and `POST /call`; the outcome returned is the daemon's result frame either way.

## 4. Authorization models

- **Phase 0 — passthrough (the model today; decision 18: this is the model, RES-0 is parked).** The caller presents a Room identity secret or agent API key; the relay reads the room board, and forwards a call with `caller.verified: true` only after its membership/claim check succeeds. Relay-side caches are bounded (identity cache 5 min; lock cache ≤ 30 s). Updates pagination must not silently truncate (defect #2871, fix in flight, PR #3132).
- **Lease tokens (specified, not deployed).** Room-minted Ed25519 compact JWS, verified against `ROOM_RESOURCE_LEASE_PUBLIC_JWK`; claims `iss` (Room origin), `aud` (`relay:<resourceId>` or `relay:<machineId>`), `sub`, `room`, `claim`, `slot`, `caps`, `epoch` (tokens older than `haltEpoch` refused), `exp` (≤ 15 min out), `jti` (revoked by listing on halt). Until the JWK is configured, lease-token calls return `503 lease_verifier_unconfigured`. **Do not build on this model without unparking RES-0 by explicit decision.**

## 5. Room → relay control plane

Room (or an operator acting for it) pushes control to the relay: `POST /v0/machines/<machineId>/halt | /pause | /resume | /bye`, carrying `X-Relay-Timestamp` (unix seconds) and `X-Relay-Signature` (hex HMAC-SHA256 of `<timestamp>.<path>.<raw body>` under `RELAY_LINK_SECRET`; skew > 300 s refused; an already-honored signature is rejected `409 replay_rejected` — retries must re-sign with a fresh timestamp or distinct body). Halt may include `epoch`, `resourceId`, `revoke: [{ "jti", "exp" }]`. **As-is note:** the relay verifies these requests (`relay/src/machine-link.mjs`), but no sender exists in `server/` today — control issuance is currently operator/relay-side. A core sender, if built, must follow this section unchanged.

## 6. Pinned constants

| Constant | Value | Source of truth |
| --- | --- | --- |
| Protocol version | `1` | `machine/lib/protocol.mjs`, `relay/src/protocol.mjs` |
| Enroll code TTL | 15 min | `relay/src/protocol.mjs` `ENROLL_TTL_MS` |
| Lease token TTL | 15 min | `LEASE_TOKEN_TTL_MS` |
| Max result frame | 4 MiB | `MAX_RESULT_BYTES` |
| Max call frame | 1 MiB | `MAX_CALL_BYTES` |
| Call timeout | 30 s | `CALL_TIMEOUT_MS` |
| Relay heartbeat | 30 s | `HEARTBEAT_MS` |
| HMAC skew window | 300 s | `HMAC_SKEW_SEC` |
| Dead-man default | 120 s | `machine/lib/protocol.mjs` `DEADMAN_DEFAULT_SECONDS` |
| Approval TTL | 10 min | `APPROVAL_TTL_MS` |
| Max macOS guests | 2 | `MAX_MACOS_GUESTS` |
| Shell output cap / timeout | 64 KiB / 30 s | `SHELL_OUTPUT_MAX_BYTES` / `SHELL_TIMEOUT_MS` |
| Guest file cap / room file cap | 8 MiB / 1 MiB | `FILE_MAX_BYTES` / `ROOM_FILE_MAX_BYTES` |

## 7. Versioning and change rules

- Changes to §§1–5 require a revision note in the PR that makes them and a version bump of this document's status line; frame-shape changes require `protocol` to advance beyond `1` in both constants files in the same change.
- The extraction (decision 18) moves `machine/` + `relay/` to their own repo; this document moves with them as the published contract, and core keeps a pointer to it. Until then, this root copy is canonical.
