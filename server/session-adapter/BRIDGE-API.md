# Bridge HTTP API contract — B4 (adapter) → B3 (bridge)

The exact wire contract `HerdrBridgeAdapter`
(`server/session-adapter/herdr-bridge-adapter.mjs`) speaks. B3 implements
`bridge/herdr-bridge.mjs` against this document. Transport design: lane D3
(`goals/project-room-herdr-redesign/phase2/design-docs/bridge-transport.md`).

Base: the bridge binds `127.0.0.1:8443`, exposed via Cloudflare Tunnel
(`https://herdr-bridge-<host>.trydemigod.com`). All request/response bodies
are JSON. Unknown routes → `404 { error: { code: "not_found" } }`.

## Auth (every route)

- `Authorization: Bearer <token>`
- `X-Bridge-Key-Id: <keyId>` — names the master-secret generation, so the
  bridge can hold current+previous during rotation without trial-decrypting.

Token derivation (both sides implement identically):

```
token = base64url( HMAC-SHA256( masterSecretBytes, "herdr-bridge-v1:" + tenantId ) )
```

- `masterSecretBytes` = the raw UTF-8 bytes of the secret value as stored via
  `wrangler secret put BRIDGE_MASTER_SECRET[_<HOST>]` (e.g. `openssl rand -base64 48` output, used verbatim).
- `tenantId` = the tenant the Worker's route table resolved.
- The bridge re-derives and compares in constant time, and resolves
  tenant → herdr server **from the verified token, never from a
  caller-supplied field**.
- Auth failure → `401`/`403` with `{ error: { code: "auth_denied", ... } }`.

## Idempotency

Every mutating route accepts `X-Idempotency-Key: <uuid v4>`, generated per
logical operation by the adapter and **reused across retries of that
operation**. The bridge keeps a 15-minute dedupe cache: a repeated key
returns the original response instead of re-executing. Timeout-retries are
safe for non-idempotent methods only because of this.

The bridge MUST cancel an orphaned server-side wait when its idempotency key
is reused (see `/v1/wait`).

## Routes

| Route | Adapter method(s) | Request body | Response body |
|---|---|---|---|
| `POST /v1/ping` | `ping`, `connect` | `{}` | `{ ok: true, service: "herdr-bridge", version: "<herdr binary version>", protocolVersion: 22, methods: ["ping","snapshot","spawn","read","send","keys","wait","report","close","list","events"] }` |
| `POST /v1/snapshot` | `snapshot` | `{}` | `{ version: 1, workspaces: [{ name, tabs: [{ name, panes: [{ id, workspace, tab, title, agentId, occupantId, state, kind }] }] }] }` |
| `POST /v1/spawn` | `spawnAgent` | `{ kind, command, args[], cwd, workspace, tab, title, resumeSessionRef, resumeCommand[] (≤64 args), metadata{} }` — adapter-constructed; the bridge builds `agent.start` argv from allowlisted kinds only | `{ id, paneId, occupantId }` |
| `POST /v1/list` | `listAgents`, `getAgent` | `{ op: "list" }` or `{ op: "get", agentId }` | `{ agents: [...] }` or `{ agent: {...} }`; unknown id → `{ error: { code: "not_found" } }` |
| `POST /v1/read` | `readPane` | `{ paneId, source: "visible"\|"recent"\|"recent-unwrapped"\|"detection", lines }` | `{ paneId, source, lines: [...], text }` |
| `POST /v1/send` | `sendText` | `{ agentId, occupantId, text }` | `{ ok: true, agentId, bytes }`; occupant moved → `{ error: { code: "occupant_changed", message } }` (the send is NOT delivered) |
| `POST /v1/keys` | `sendKeys` | `{ agentId, occupantId, keys[] }` | `{ ok: true }`; occupant rules as `/v1/send` |
| `POST /v1/wait` | `waitForState`, `waitForOutput` | `{ mode: "state", agentId, occupantId, states[], timeoutMs }` or `{ mode: "output", paneId, pattern, flags, timeoutMs }` | `{ matched: true, state }` / `{ matched: true, matchedLine }`, or `{ matched: false, elapsedMs }` when the bridge-side round times out without a match |
| `POST /v1/report` | `reportState`, `reportResume`, `reportMetadata` | `{ report: "state", paneId, state, detail }` / `{ report: "resume", paneId, ref: { sessionRef, resumeCommand } }` / `{ report: "metadata", paneId, meta{}, ttlMs? }` | `{ ok: true }` |
| `POST /v1/close` | `closePane` | `{ paneId }` | `{ ok: true }` (idempotent) |
| `GET /v1/events?since=<seq>` | `subscribe` | — | Server-Sent Events (below) |

## SSE (`GET /v1/events`)

- `Content-Type: text/event-stream`. Heartbeat at least every 25s, as an SSE
  comment (`: heartbeat`) or an `event: heartbeat` frame — the adapter treats
  >50s of silence as a dead stream.
- Data frames: `data: {"seq": <int>, "type": "<event>", ...}`. `seq` is the
  cursor; the adapter resubscribes with `?since=<last seen seq>`.
- Event history overrun: send `event: events_lost` + 
...[truncated 1677 chars]