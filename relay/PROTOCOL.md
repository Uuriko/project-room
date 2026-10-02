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

`displayName` is optional. `profile`, when present, must be `contribute`. The returned code is `<machineId>.<verifier>`. It is single use and expires 15 minutes after minting. `POST /admin/enroll-codes/<machineId>/expire` revokes an unused code immediately.

`POST /v0/enroll` with `{ "code" }` returns the body in machine/PROTOCOL.md. `relayUrl` is `wss://<relay>/v0/machines/link`. The machine token is returned once. The relay stores only its SHA-256. A wrong token is HTTP 401. The token is not accepted as a query parameter.

A second connection for the same machine closes the previous socket with code `4001` and reason `replaced`. Calls still in flight on the old socket fail with `409 link_replaced`.

## Socket

The daemon connects to `relayUrl` and sends `Authorization: Bearer <machineToken>`. Hello is `{ "type": "hello", "protocol": 1, "machineId", "label", "version" }`. The relay sends `heartbeat` on connect and about every 30 seconds while the socket is open, so a quiet link stays inside the daemon's dead-man window.

`call` is sent only after the relay's own Phase 0 check succeeds. `caller.verified` is `true` on that frame and is not set when the check fails. Slots on that frame are `desk` and `scratch`. `args` is the tool argument object.

`halt` is `{ "type": "halt", "epoch": <number> }`. `pause` is `{ "type": "pause", "minutes": <number> }`. `resume` is `{ "type": "resume" }`. `bye` is `{ "type": "bye" }`.

The daemon answers `{ "type": "result", "id", "ok", "result" | "error" }`. A result may be up to 4 MiB. The relay returns that outcome on both MCP and `POST /call`. A tool failure is a normal result with `isError: true`, not an HTTP error.

## Tools

`tools/list` returns the default allowlist in machine/PROTOCOL.md. A name outside that list is refused with `403 tool_not_allowed` and is not forwarded. There is no host shell.

When `hello` does not include `tools`, the relay serves the default allowlist from machine/PROTOCOL.md: `machine.status`, `machine.release`, `desktop.screenshot`, `desktop.click`, `desktop.type`, `desktop.key`, `desktop.scroll`, `desktop.list_apps`, `shell.vm`, `files.put`, `files.get`, `inference.chat`.

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

Room pushes control to `POST /v0/machines/<machineId>/halt`, `/pause`, `/resume`, and `/bye`. Those requests carry `X-Relay-Timestamp` (unix seconds) and `X-Relay-Signature` (hex HMAC-SHA256 of `<timestamp>.<raw body>` under `RELAY_LINK_SECRET`). Skew over 300 seconds is refused. Halt may include `epoch`, `resourceId`, and `revoke: [{ "jti", "exp" }]`. Pause requires `minutes`, an integer from 0 through 10080.
