# Project Room relay

A separate Cloudflare Worker that carries machine tool calls. Room stays the control plane. The relay refuses a call that a live lease does not back.

The Worker name is `project-room-relay`. It is off until someone deploys it. `RELAY_PHASE0_PASSTHROUGH` defaults to `0`. Nothing in this directory attaches a public hostname. The parent attaches a route or a custom domain after deploy.

Room's own Worker does not accept machine sockets. The daemon dials out. The wire contract is [machine/PROTOCOL.md](../machine/PROTOCOL.md). This directory speaks that contract. [PROTOCOL.md](PROTOCOL.md) is the relay side of it.

## What callers use

Each machine is remote MCP at `/v0/machines/<machineId>/mcp` (Streamable HTTP, protocol `2025-11-25`) and the same tools at `POST /v0/machines/<machineId>/call` with `{ "tool", "arguments" }`. Both return `{ "content", "isError", "structuredContent" }`.

This Worker does not issue OAuth tokens. `GET /.well-known/oauth-protected-resource/v0/machines/<machineId>/mcp` names Room as the authorization server. Phase 0 clients send `Authorization: Bearer`.

- Passthrough (`RELAY_PHASE0_PASSTHROUGH=1`) accepts a Room identity secret or agent API key. The relay checks it with Room's existing membership and board reads. The bearer is not stored and is not written to logs. The decision is cached for at most 30 seconds (`RELAY_LOCK_CACHE_MS`).
- The default refuses that bearer. The caller presents a Room lease token instead. Verification needs `ROOM_RESOURCE_LEASE_PUBLIC_JWK`, which arrives with RES-0.

`GET /healthz` reports `phase0Passthrough` and the names of any secrets that are still unset. It does not report secret values.

## Operator routes

`POST /admin/enroll-codes` with `Authorization: Bearer <RELAY_ADMIN_TOKEN>` mints a one-time code:

```json
{
  "label": "Ada's desk",
  "rooms": ["room_alpha"],
  "ownerMemberId": "mem_ada",
  "inviteCode": "RM-0123456789ABCDEF",
  "roomOrigin": "https://room.trydemigod.com",
  "displayName": "Mac bot (Ada)"
}
```

`inviteCode` is the Room contribute invite the parent already minted. `roomOrigin` and `displayName` are optional. The code is `<machineId>.<verifier>`. It expires in 15 minutes, and it is bound to that label, those rooms, that owner, and the invite. `POST /v0/enroll` with `{ "code" }` returns the machine token, `roomId`, `inviteCode`, and `relayUrl` (`wss://<request-host>/v0/machines/<machineId>/link`). `POST /enroll` is the same handler with a `Deprecation: true` header, kept for one release. A bad code is `401 {"error":"code_invalid"}`. A used or expired code is `410 {"error":"code_used"}` or `410 {"error":"code_expired"}`.

`POST /admin/enroll-codes/<machineId>/expire` revokes an unused code immediately.

`POST /v0/machines/<machineId>/halt`, `/pause`, and `/resume` use the link HMAC described in [PROTOCOL.md](PROTOCOL.md). The socket frames are `{ "type": "halt", "epoch" }`, `{ "type": "pause", "minutes" }`, and `{ "type": "resume" }`. A forwarded call is `{ "type": "call", "args", "caller": { "verified": true } }` after the relay's own check.

## Deploy

Do not deploy from a pull request. The parent deploys after merge, with the existing Cloudflare account. No new account.

From the repository root, after `npm ci --prefix relay`:

```sh
npx wrangler deploy -c relay/wrangler.jsonc
```

Generate the two relay secrets and put them on the Worker. Do not commit the values.

```sh
openssl rand -base64 32 | npx wrangler secret put RELAY_ADMIN_TOKEN -c relay/wrangler.jsonc
openssl rand -base64 32 | npx wrangler secret put RELAY_LINK_SECRET -c relay/wrangler.jsonc
```

When RES-0 publishes the lease public key, put the JWK JSON the same way:

```sh
npx wrangler secret put ROOM_RESOURCE_LEASE_PUBLIC_JWK -c relay/wrangler.jsonc
```

Until that secret exists, `/healthz` lists `ROOM_RESOURCE_LEASE_PUBLIC_JWK` under `missing`, and lease-token calls return `503 lease_verifier_unconfigured`. Passthrough stays off. The parent sets the var `RELAY_PHASE0_PASSTHROUGH` to `1` only for the pilot, then redeploys. That var is not a secret.

`wrangler.jsonc` enables `workers_dev` and attaches `relay.trydemigod.com` as a custom domain. `relayUrl` is taken from the host that served the enroll request, so mint a code only after the hostname the Mac will use is the one answering that request.

## Tests

Workerd checks live in `relay/checks` and use Miniflare. The directory is not named `test`, so the root `npm test` suite does not collect them.

```sh
npm ci --prefix relay
npm --prefix relay test
npx wrangler deploy --dry-run --outdir dist -c relay/wrangler.jsonc
```

The dry-run writes `relay/dist`. That directory is build output and is not committed.
