# room-machine/0.1

Wire protocol between a machine daemon and the relay Worker. The source of truth is [machine/PROTOCOL.md](../machine/PROTOCOL.md). This file is the relay side of that contract: enroll, the socket, and the caller-facing MCP and REST surface.

Frames are JSON text. One JSON object per WebSocket message. A frame larger than 1048576 bytes is refused. A result the daemon sends is at most 4 MiB.

## Enroll

`POST /v0/enroll` with `{ "code": "<one-time code>" }`.

`POST /enroll` is the same handler with a `Deprecation: true` response header. It is a one-release alias.

`200`:

```json
{
  "machineToken": "secret",
  "machineId": "mch_0123456789abcdef",
  "label": "spare",
  "roomId": "commons",
  "ownerMemberId": "mem_owner",
  "inviteCode": "RM-...",
  "displayName": "Room machine",
  "relayUrl": "wss://relay.example/v0/machines/mch_0123456789abcdef/link",
  "roomOrigin": "https://room.trydemigod.com"
}
```

`displayName` and `roomOrigin` are omitted when the enroll record has none. `roomId` is the first room on the allowlist. `relayUrl` uses the request host: `wss://` when the enroll request was `https`, otherwise `ws://`, then `/v0/machines/<machineId>/link`.

`401` `{ "error": "code_invalid" }`

`410` `{ "error": "code_used" }` or `{ "error": "code_expired" }`

The code is single use and expires 15 minutes after it is minted. The parent stores the Room agent invite on the enroll record. The relay does not create the Room identity.

The machine token is returned once. The relay stores only its SHA-256.

## Link

The daemon dials `relayUrl`. It does not listen.

Authenticate with either header:

- `Authorization: Bearer <machineToken>`
- `X-Machine-Token: <machineToken>`

The token is not a query parameter. A wrong token is HTTP 401 and no socket is kept. A second connection for the same machine sends `{ "type": "bye" }` and then closes the previous socket with code `4001` and reason `replaced`. Calls still in flight on the old socket fail with `409 link_replaced`.

## Daemon to relay

`hello` is the first frame the daemon sends.

```json
{ "type": "hello", "protocol": 1, "machineId": "mch_0123456789abcdef", "label": "spare", "version": "0.1.0" }
```

`protocol` must be `1` when it is present. A `tools` array is optional. When it is present, the relay stores the names that pass its allowlist. When it is absent, the relay serves the daemon's default allowlist. Host shell is never stored.

`result` answers one `call`. `id` is the id from that call. `ok: true` carries `result`. `ok: false` carries `error` with `code` and `message`. The relay returns that outcome on both MCP and `POST /call`. A tool failure is a normal result with `isError: true`, not an HTTP error.

```json
{ "type": "result", "id": "call-id", "ok": true, "result": { "shot": true } }
```

```json
{ "type": "result", "id": "call-id", "ok": false, "error": { "code": "missing", "message": "no such file" } }
```

An inbound `heartbeat` refreshes the link. The daemon does not have to send one.

## Relay to daemon

The relay sends `{ "type": "heartbeat" }` when the socket is accepted, again after `hello`, and about every 30 seconds while the socket stays up. That marks the link healthy for the daemon.

`call` asks the daemon to run one tool. `verified` is `true` only after the relay's own check (Phase 0 passthrough or a lease token) has succeeded. `args` is the tool argument object.

```json
{ "type": "call", "id": "c1", "tool": "machine.status", "args": {}, "caller": { "identityId": "ai_...", "claimId": "lease1", "slot": "desk", "verified": true } }
```

`halt` means stop. `epoch` only increases.

```json
{ "type": "halt", "epoch": 1 }
```

`pause` suspends guests for `minutes`.

```json
{ "type": "pause", "minutes": 30 }
```

`resume` clears halt and pause.

```json
{ "type": "resume" }
```

`bye` tells the daemon the relay is closing this socket. The daemon keeps the process up and reconnects if the socket drops.

```json
{ "type": "bye" }
```

The relay sends `halt`, `pause`, and `resume` within the matching request, and the daemon sees them on a live socket.

## Tools the relay will forward

The daemon may report other names. The relay drops them and never calls them. Host shell is not in this list.

- `desktop.*`
- `shell.vm` and `shell.vm.*`
- `files` and `files.*`
- `browser.*`
- `xcode.*`
- `inference.*`
- `machine.*`
- `credential.use` and `credential.use.*`

At most 64 tools are kept. Names are at most 128 characters. Descriptions are cut at 512 characters.

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
| `slot` | Slot name |
| `caps` | Capability strings |
| `epoch` | Integer. Tokens older than `haltEpoch` are refused |
| `exp` | Unix seconds, no further than 15 minutes out |
| `jti` | Token id. A live token may be presented again. Room revokes one by listing its `jti` on halt |

Phase 0 passthrough does not use these tokens. The caller sends a Room identity secret or agent API key, and the relay reads the board. A call is forwarded with `caller.verified: true` only after that check succeeds. Until `ROOM_RESOURCE_LEASE_PUBLIC_JWK` is set, lease-token calls stay `503 lease_verifier_unconfigured`.

## Slots

A board file `resource/<machineId>/<slot>` is one slot. Of the active, unexpired claims of `kind: "work"` on that path, the earliest `claimedAt` holds it. `done`, `unclaimed`, a lapsed `leaseExpiresAt`, another kind, and a different slot do not.

The daemon itself accepts only `desk` and `scratch`. The relay still forwards the slot the board claim names.

## Control plane

Room pushes halt, pause, and resume to `POST /v0/machines/<machineId>/halt`, `/pause`, and `/resume`. Those requests carry `X-Relay-Timestamp` (unix seconds) and `X-Relay-Signature` (hex HMAC-SHA256 of `<timestamp>.<raw body>` under `RELAY_LINK_SECRET`). Skew over 300 seconds is refused. The halt body may include `epoch`, `reason`, `resourceId`, and `revoke: [{ "jti", "exp" }]`. The socket frame is `{ "type": "halt", "epoch" }`. The pause body is `{ "minutes": 30 }` and the socket frame is `{ "type": "pause", "minutes": 30 }`. Resume uses `{}` and the socket frame is `{ "type": "resume" }`.
