# herdr-bridge key rotation (dual-key procedure)

Tokens are **derived**, not stored: `base64url(HMAC-SHA256(master, "herdr-bridge-v1:"+tenantId))`.
Rotating the per-host master secret re-keys every tenant at once — no per-tenant
re-provisioning. The bridge accepts two generations during the window; the
Worker's `X-Bridge-Key-Id` header selects which one to verify against.

## Key locations

| Side | Location | Mode |
|---|---|---|
| Bridge host | `/etc/herdr-bridge/env` (`BRIDGE_MASTER_SECRET`, `BRIDGE_KEY_ID`, …) | `0600 root:herdr-bridge` |
| Cloudflare Worker | `wrangler secret` per bridge host, e.g. `BRIDGE_MASTER_SECRET_lane-host-01` | Worker secrets store |
| Route table | Worker env var, maps bridge host → `keyId` generation | versioned JSON |

Never: tokens in URLs, tokens in logs, the master in the repo, or one master
shared across hosts (per-host blast radius).

## Rotation procedure (zero-downtime)

Generations are named by date, e.g. `2026-10-a` → `2026-11-a`.

1. **Generate** the new secret on the bridge host (never on a shared machine):
   `openssl rand -base64 48`
2. **Bridge host:** add it as the *previous* generation first — this is the
   no-risk direction:
   ```
   # /etc/herdr-bridge/env
   BRIDGE_MASTER_SECRET=<current, unchanged>
   BRIDGE_MASTER_SECRET_PREV=<new>
   BRIDGE_KEY_ID=2026-10-a
   BRIDGE_KEY_ID_PREV=2026-11-a
   ```
   `systemctl restart herdr-bridge` (or `reload` once SIGHUP config reload lands).
3. **Worker:** update the route-auth table entry for this bridge host:
   `keyId: "2026-11-a"`, and set the new secret in `wrangler secret`.
   Deploy the Worker. From this point the Worker derives tokens with the new
   master; the bridge verifies them against `BRIDGE_MASTER_SECRET_PREV`.
4. **Promote on the bridge:** swap the generations —
   `BRIDGE_MASTER_SECRET=<new>`, `BRIDGE_KEY_ID=2026-11-a`, and drop the
   `_PREV` lines. Restart. (Order matters: promoting before step 3 would
   reject the Worker's still-old tokens.)
5. **Verify:** `GET /healthz` shows `missing: []`; one `POST /v1/ping` per
   tenant succeeds; the audit log shows no `auth_denied` spike.
6. **Close the window:** old secret is now cryptographically dead. Delete it
   from the Worker secrets store.

## Emergency rotation (suspected compromise)

Skip the window: set the new secret directly as `BRIDGE_MASTER_SECRET` with a
new `BRIDGE_KEY_ID`, update the Worker secret + route table in the same change,
restart both. In-flight sessions fail closed (bearer mismatch → `auth_denied`);
callers re-`connect()` and resume on the new generation. Expect a brief
`auth_denied` spike in the audit log — that spike is the signal the rotation
took effect.

## What rotation does NOT do

- It does not invalidate outstanding **occupant handles**: handles are
  bridge-local opaque tokens, unaffected by bearer rotation.
- It does not touch the **idempotency cache**: in-flight retries keep their keys.
- It does not restart tenant herdr servers.
