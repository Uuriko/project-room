# room-machine/0.1

Wire protocol between a machine daemon and the relay Worker. MAC-AGENT-0 implements the daemon side of this document. The relay speaks it on the outbound WebSocket at `/v0/machines/<machineId>/link`.

Frames are JSON text. One JSON object per WebSocket message. A frame larger than 1048576 bytes is refused.

## Link

The daemon dials out. It does not listen. The URL comes from `POST /enroll`:

`wss://<relay>/v0/machines/<machineId>/link`

Authenticate with either header:

- `Authorization: Bearer <machineToken>`
- `X-Machine-Token: <machineToken>`

The machine token is returned once, from `POST /enroll`. The relay stores only its SHA-256. A wrong token is HTTP 401 and no socket is kept. A second connection for the same machine closes the previous socket with code `4001` and reason `replaced`. Calls still in flight on the old socket fail with `409 link_replaced`.

## Daemon to relay

`hello` is the first frame the daemon sends. The relay stores the tools that pass its allowlist and answers with `welcome`.

```json
{ "type": "hello", "version": "room-machine/0.1", "tools": [
  { "name": "desktop.screenshot", "description": "Capture the desk", "inputSchema": { "type": "object", "properties": {} } }
]}
```

`heartbeat` keeps the link fresh. `at` is an ISO-8601 timestamp from the daemon.

```json
{ "type": "heartbeat", "at": "2026-10-02T00:00:00.000Z" }
```

`result` answers one `call`. `id` is the id from that call. `ok: true` carries `result`. `ok: false` carries `error` with `code` and `message`. The relay returns that outcome on both MCP and `POST /call`. A tool failure is a normal result with `isError: true`, not an HTTP error.

```json
{ "type": "result", "id": "call-id", "ok": true, "result": { "shot": true } }
```

```json
{ "type": "result", "id": "call-id", "ok": false, "error": { "code": "missing", "message": "no such file" } }
```

## Relay to daemon

`welcome` is sent when the socket is accepted, and again after `hello`.

```json
{ "type": "welcome", "machineId": "mch_0123456789abcdef", "haltEpoch": 0, "protocol": "room-machine/0.1", "halted": false }
```

`call` asks the daemon to run one tool. Run it only when `lease` is present. `exp` is a unix second, or null when the backing claim has no lease expiry. `caps` is the lease-token capability list. Phase 0 passthrough sends an empty list because the board claim is the capability.

```json
{ "type": "call", "id": "call-id", "tool": "desktop.screenshot", "arguments": {}, "lease": {
  "claim": "claim_ada", "slot": "desk", "holder": "idn_ada", "room": "room_alpha", "exp": 1780000000, "caps": ["desktop.gui"]
}}
```

`halt` means stop. Drop work in flight. Do not run another `call` until `resume`. `haltEpoch` only increases.

```json
{ "type": "halt", "haltEpoch": 1, "reason": "halt" }
```

`resume` clears the halt. `haltEpoch` stays where it is, so a lease minted before the halt is still stale.

```json
{ "type": "resume", "haltEpoch": 1 }
```

The relay sends `halt` and `resume` within the halt request, and the daemon sees them in under 2 seconds on a live socket.

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

Phase 0 passthrough does not use these tokens. The caller sends a Room identity secret or agent API key, and the relay reads the board.

## Slots

A board file `resource/<machineId>/<slot>` is one slot. Of the active, unexpired claims of `kind: "work"` on that path, the earliest `claimedAt` holds it. `done`, `unclaimed`, a lapsed `leaseExpiresAt`, another kind, and a different slot do not.

## Control plane

Room pushes halt and resume to `POST /v0/machines/<machineId>/halt` and `/resume`. Those requests carry `X-Relay-Timestamp` (unix seconds) and `X-Relay-Signature` (hex HMAC-SHA256 of `<timestamp>.<raw body>` under `RELAY_LINK_SECRET`). Skew over 300 seconds is refused. The body may include `epoch`, `reason`, `resourceId`, and `revoke: [{ "jti", "exp" }]`.
