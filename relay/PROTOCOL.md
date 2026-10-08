# Relay operator notes

The daemon wire contract is [machine/PROTOCOL.md](../machine/PROTOCOL.md). The relay speaks that document: `POST /v0/enroll`, protocol `1` hello, and the frames `heartbeat`, `halt`, `pause`, `resume`, `bye`, and `call`. This file is the operator surface around that contract. The relay does not create a Room identity and does not redeem the invite.

## Enroll

An operator mints a Room agent invite with `profile: "contribute"`, then stores that code on the enroll record.

`POST /admin/enroll-codes` with `Authorization: Bearer <RELAY_ADMIN_TOKEN>`:

```json
{
  "label": "spare",
  "roomId": "commons",
  "ownerMemberId": "owner",
  "inviteCode": "RM-...",
  "displayName": "Room machine"
}
```

`rooms` (1..8 ids) is accepted in place of `roomId`. The enroll reply's `roomId` is the first room. `roomOrigin` and `displayName` are optional and are stored on the enroll record. `profile`, when present, must be `contribute`. The returned code is `<machineId>.<verifier>`. It is single use and expires 15 minutes after minting. `POST /admin/enroll-codes/<machineId>/expire` revokes an unused code immediately.

`POST /v0/enroll` with `{ "code" }` returns the body in machine/PROTOCOL.md. `POST /enroll` is the same handler with `Deprecation: true`, kept for one release. `relayUrl` is taken from the host that served the enroll request: `wss://<host>/v0/machines/link` (or `ws://` when the enroll request was not https). The machine id is the first label of the machine token, not a path segment. The machine token is returned once. The relay stores only its SHA-256. A wrong token is HTTP 401. The token is not accepted as a query parameter.

A second connection for the same machine closes the previous socket with code `4001` and reason `replaced`. Calls still in flight on the old socket fail with `409 link_replaced`.

## Socket

The daemon connects to `relayUrl` and sends `Authorization: Bearer <machineToken>`. Hello is `{ "type": "hello", "protocol": 1, "machineId", "label", "version" }`. The relay sends `heartbeat` on connect and about every 30 seconds while the socket is open, so a quiet link stays inside the daemon's dead-man window.

`call` is sent only after the relay's own Phase 0 check succeeds. `caller.verified` is `true` on that frame and is not set when the check fails. Slots on that frame are `desk` and `scratch`. `args` is the tool argument object.

`halt` is `{ "type": "halt", "epoch": <number> }`. `pause` is `{ "type": "pause", "minutes": <number> }`. `resume` is `{ "type": "resume" }`. `bye` is `{ "type": "bye" }`. When a daemon says `hello`, the relay sends the current `halt`, or a `pause` with the remaining minutes rounded up, so a control issued while the machine was offline still reaches it. A `resume` issued while it was offline is not replayed.

The daemon answers `{ "type": "result", "id", "ok", "result" | "error" }`. A result may be up to 4 MiB. The relay returns that outcome on both MCP and `POST /call`. A tool failure is a normal result with `isError: true`, not an HTTP error.

## Tools

`tools/list` returns the default allowlist in machine/PROTOCOL.md. A name outside that list is refused with `403 tool_not_allowed` and is not forwarded. There is no host shell. Hello does not change that list.

## Lease tokens

Room mints Ed25519 compact JWS lease tokens. The relay verifies them with `ROOM_RESOURCE_LEASE_PUBLIC_JWK`. Claims:

| Claim | Meaning |
| --- | --- |
| `iss` | Room origin, no trailing slash |
| `aud` | `relay:<resourceId>` after Room has bound one, otherwise `relay:<machineId>` |
| `sub` | Holder identity |
| `room` | Room id |
| `claim` | Work-claim id |
| `slot` | `desk` or `scratch` |
| `caps` | Capability strings |
| `epoch` | Integer. Tokens older than `haltEpoch` are refused |
| `exp` | Unix seconds, no further than 15 minutes out |
| `jti` | Token id. A live token may be presented again. Room revokes one by listing its `jti` on halt |

Phase 0 passthrough does not use these tokens. The caller sends a Room identity secret or agent API key, and the relay reads the board. A call is forwarded with `caller.verified: true` only after that check succeeds. Until `ROOM_RESOURCE_LEASE_PUBLIC_JWK` is set, lease-token calls stay `503 lease_verifier_unconfigured`.

## Slots

A board file `resource/<machineId>/<slot>` is one slot. `slot` is `desk` or `scratch`. Of the active, unexpired claims of `kind: "work"` on that path, the earliest `claimedAt` holds it. `done`, `unclaimed`, a lapsed `leaseExpiresAt`, another kind, and the other slot do not.

The daemon itself accepts only `desk` and `scratch`. The relay still forwards the slot the board claim names.

## Control plane

Room pushes control to `POST /v0/machines/<machineId>/halt`, `/pause`, `/resume`, and `/bye`. Those requests carry `X-Relay-Timestamp` (unix seconds) and `X-Relay-Signature` (hex HMAC-SHA256 of `<timestamp>.<path>.<raw body>` under `RELAY_LINK_SECRET`). The path is signed so a signature cut for one action cannot be replayed as another. Skew over 300 seconds is refused, and a signature the machine already honored is rejected with 409 `replay_rejected`. A signed control request is single-use inside the window: a byte-identical retry in the same second is indistinguishable from a replay, so clients must re-sign retries with a fresh timestamp or a distinct body; treat 409 `replay_rejected` as "already applied". Halt may include `epoch`, `resourceId`, and `revoke: [{ "jti", "exp" }]`. Pause requires `minutes`, an integer from 1 through 10080; 0 is refused with 422 `invalid_pause` because the daemon ignores a pause with no duration (use `/resume` to end a pause).
