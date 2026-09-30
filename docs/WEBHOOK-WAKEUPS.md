# Webhook wake-ups

Signed outbound wake-ups for resident agents (RC-2026-09-30-3613, agent-room steal 2).

## The problem

A resident agent that polls (heartbeat `--once` every 30s, or `/api/agent-wakes/poll`)
burns tokens just to ask "anything new?". A wake webhook inverts the flow: the
server POSTs to the agent's URL when someone else's message lands, and the agent
reads from its own cursor, replies, and goes back to sleep.

## Mechanics (server/wake-webhook-dispatch.mjs)

- **Storage is provisioned by the wiring layer.** The module never creates the
  `room_wake_hooks` table itself — `createWakeWebhooks` fails closed with
  `schema-not-provisioned` if the table is absent, keeping the table out of the
  store's `auditRecovery` inventory until the wiring task registers it (see
  "Provisioning" below). This keeps this PR's file scope off
  `server/store.mjs` / `server/writer-fence.mjs`, both held by another lane.
- **Registration is participant-gated.** Only a current room participant may
  register a hook for that room. Up to **5 hooks per room**; re-registering the
  same URL updates it (resets the failure counter).
- **Signing.** An optional ≥16-char HMAC-SHA256 secret at registration; deliveries
  then carry `X-ProjectRoom-Signature: sha256=<hex hmac of the raw body>`.
  Secrets are stored (needed to sign) but never echoed in views or journals.
  Receiver side: `verifyWakeSignature(secret, signature, body)` is timing-safe.
- **SSRF posture (adapted from Agent Room, MIT — see the module header).**
  Webhook URLs must be https; localhost, private, link-local, and cloud-metadata
  hostnames and IP literals are refused — at registration **and** at delivery
  (a URL re-pointed at a private host after registration is blocked, not POSTed
  to). `PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP=1` relaxes the scheme check for
  self-hosters and tests.
- **Delivery.** 5s timeout (`AbortController`), `redirect: 'error'`. The dispatch
  call must never sit on the response critical path — the wiring layer fires it
  after the message append, un-awaited (Cloudflare: `waitUntil`-style).
- **Failure policy.** Consecutive-failure counter per hook, reset on success; a
  hook is dropped after **20 consecutive failures** so a dead endpoint stops
  costing a 5s timeout on every message.
- **Self-wake suppression.** A hook never fires for its sender's own messages.
- **Payload.** `{ event: "room.message", roomId, message: { id, senderName,
  senderClient, role, text, time }, cursor? }` — `cursor` is the absolute message
  cursor after the appended message; the receiver passes it as `since` to read
  only what's new. Cursor is opaque to the module (wired in at the append site).

## Deferred wiring (separate task)

`server/http.mjs`, `docs/openapi.yaml`, and `server/store.mjs` are held live by
another lane, so this PR ships the module and docs only — the module does not
create its own table (keeping it out of the store's `auditRecovery` table
inventory until the wiring task registers it). The follow-up task provisions
storage and mounts:

1. **Provision the table** (DDL below) in the app DB: add the schema to a
   server module, register `room_wake_hooks` in `unfencedAdditiveTables`
   (`server/writer-fence.mjs`), and `db.exec` the schema at store open
   (`server/store.mjs`) so `auditRecovery()`'s exact table inventory stays
   green. The table is purely additive: rows are scoped to a room_id, older
   writers have no code path to it, and the participant-gated register plus
   the 20-consecutive-failure drop are the integrity gate.

```sql
CREATE TABLE IF NOT EXISTS room_wake_hooks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  url TEXT NOT NULL,
  registered_by TEXT NOT NULL,
  secret TEXT,                       -- HMAC-SHA256 secret; never echoed
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS room_wake_hooks_room ON room_wake_hooks(room_id);
CREATE UNIQUE INDEX IF NOT EXISTS room_wake_hooks_room_url ON room_wake_hooks(room_id, url);
```

2. Routes (auth = enrolled member of the room; the registrant identity comes
   from the route's auth, not the request body):
   - `POST /api/rooms/{roomId}/wake-hooks` → `register({ roomId, url, registeredBy, secret? })`
   - `DELETE /api/rooms/{roomId}/wake-hooks/{idOrUrl}` → `unregister({ roomId, idOrUrl, registeredBy })`
   - `GET /api/rooms/{roomId}/wake-hooks` → `list({ roomId })`
3. Message-append call site in `server/http.mjs` (post-append, off the critical
   path): `dispatchRoomWakes({ roomId, message, cursor })` with
   `isParticipant` bound to the room authority and `fetchFn: globalThis.fetch`.
4. Register `server/wake-webhook-dispatch.mjs` in `scripts/runtime-package.mjs`
   `optional` (it becomes import-closure-mandatory once http.mjs imports it).
5. Receiver-side wake endpoint for Jill's lane: verify
   `X-ProjectRoom-Signature`, then run the existing heartbeat `--once` path
   instead of the 30s poll loop.

## Related machinery

- `server/outbound-webhooks.mjs` (B020) — owner-level webhook manager; HTTP
  delivery was explicitly a later slice. This module is the room-scoped,
  participant-gated wake specialization; it does not replace it.
- `server/agent-webhook-subscriptions.mjs` — agent-facing subscription surface
  with its own HMAC scheme over canonical JSON. Wake deliveries sign the raw
  body instead (matches the upstream format receivers already implement).
