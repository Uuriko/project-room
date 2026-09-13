# Production gates — detailed plan (2026-09-13)

This is the launch path for **Project Room as a chat room people can use**, not a feature dump. Live Room is schema **26** (`a5f2dca`). This tree is schema **33** and has not been deployed. Public MCP stays `ship: false`. Gmail/Telegram/SMS stay off for launch.

John authorized local implementation. **No git push, no wrangler deploy, no live Durable Object write** until a copy-first cutover is explicit.

---

## 0. What “production” means here

A hosted Room where:

1. HTTPS origin is exact (`ROOM_ORIGIN`). Host header spoofing 403s.
2. Humans sign in with **Clerk** on that origin (`https://clerk.trydemigod.com` issuer, pinned JWKS/PEM, `authorizedParties` = origin). Email is not an account key.
3. Welcome members have `permissions: []` except one **named operator** account (`idp-<64 hex>`), which gets `manage_members` only (not `decide`, not owner). Owner remains `welcome-host`.
4. Two humans can chat, hard-refresh, revoke, reconnect on a **copy** of storage.
5. An owner can mint one agent (Contribute or Max; never `manage_members`/`decide`).
6. Private grants live in `private_inbox_*` and **must** be dump/restored separately from room event JSONL. Event import stays 409 online.
7. Public MCP walk-in stays unpublished (`openJoinContract().ship === false`). Origin 403, join `unavailable`.

Not launch: live mailbox connectors, Slack install, VDR, public MCP persist-join, DIE on www.

---

## 1. Clerk fail-closed (`ROOM_PRODUCTION=1`)

### Why
Worker already calls `providerConfig(env, ROOM_ORIGIN)` and returns **null** when Clerk env vars are absent. Staging then looks like “Join” is optional. Production must not boot a public HTTPS origin without Clerk.

### Research constraints
- Clerk session JWTs are short-lived (~60s); refresh is a new verified exchange, never cookie extension of another browser (already true in `refreshWithProvider`).
- Verify **networkless** with pinned RSA-2048 PEM (`ROOM_CLERK_PUBLIC_KEY`), not `jku` / `jwks_uri` from the token.
- `authorizedParties` must be the app origin only.
- `pk_test_` is loopback-only; production origin requires `pk_live_` whose payload decodes to `{issuer host}$`.

### Implementation
`server/production-gates.mjs` → `assertProductionReady(env, origin, { ship })`:

- No-op unless `ROOM_PRODUCTION=1`.
- Require `providerConfig(env, origin)` non-null (throws on partial/mismatch).
- Require `ROOM_OPERATOR_ACCOUNT_ID` matching `^idp-[a-f0-9]{64}$`.
- Require `ship === false` (import `openJoinContract().ship`).
- Return `{ production: true, providerAuth, operatorAccountId }`.

Wire:

- `server.mjs` after `deploymentConfig()`.
- `cloudflare/room.mjs` in `ProjectRoom` constructor before `createRoomServer`.

Tests (`tests/production-gates.test.js`): missing clerk throws; partial clerk throws; test key on https origin throws; operator missing/malformed throws; `ship: true` throws; happy path returns config; `ROOM_PRODUCTION` unset still allows null clerk.

### Not in this slice
Putting real Clerk secrets in git or wrangler.jsonc. Operators set Wrangler secrets. Optional `wrangler.production.jsonc` with `ROOM_ORIGIN` only.

---

## 2. Named operator on Welcome

### Why
Welcome `permissions: []` is correct for the crowd. Production still needs one human who can mint agents and export diagnostics without publishing the host key.

### Rules
- Identity is **issuer+sub hash** (`idp-…`), never email.
- Promotion only on room `welcome` with bootstrap `provider-welcome-v1`.
- Actor is `welcome-host` (owner). Event `member.access_changed` to `permissions: ["manage_members"]`.
- No `decide`. Owner stays `welcome-host`.
- Second login does not stack extra grants if already `manage_members`.
- Non-matching accounts stay `[]`.
- Pre-shared private starter rooms (`room-<digest>`) are **not** auto-promoted.

### Implementation
`loginWithProvider(..., { operatorAccountId })` after membership is bound, still inside the same transaction as join.

`createRoomServer({ operatorAccountId })` passes env `ROOM_OPERATOR_ACCOUNT_ID` from Node and Worker.

Tests: compute `idp-` for `user_alice`; login with operatorAccountId → Welcome member has `manage_members`; other sub stays `[]`; private-starter path unchanged.

---

## 3. Private grant journal dump / restore

### Why
`GET /export` is event JSONL. Grants are in `private_inbox_commands` (plus sources/versions/drafts). A restore from events **drops grants**. HTTP `POST /import` stays 409 `recovery_requires_maintenance`.

### Implementation
`Inbox.dumpJournal()` / `Inbox.restoreJournal(dump)`:

- Format `project-room-private-inbox-v1`.
- Tables in FK order: sources → versions → drafts → commands.
- Restore **only** onto empty inbox tables. Accounts must already exist (FK).
- Never include credential hashes, Google tokens, or room events.
- Not an HTTP route in this slice (avoids a new public leak). Script `scripts/maintenance-inbox-backup.mjs` reads/writes a file for an operator on a **copy** DB.

Tests: dump contains grant rows and selected body; room export JSON still omits them; restore onto a fresh DB with the same account id restores `readGrant`; restore onto non-empty commands throws; HTTP import still 409.

---

## 4. Two-human hosted drill (copy, not live)

### Why
Cloudflare: one Worker version per Durable Object; rollback restores **code** not SQLite. PITR is last-30-days on SQLite DOs. Do not point schema 33 at live schema 26 (`a5f2dca`).

### Implementation
`scripts/hosted-drill.mjs` (loopback default):

1. Temp SQLite copy (never `ROOM_DB` production path unless `ROOM_DRILL_ALLOW_LIVE=1` which we do **not** set).
2. Two Clerk-shaped logins (`user_alice`, `user_bob`) with synthetic verify.
3. Alice is operator; Bob is not.
4. Bob posts a Welcome chat command; Alice sees it via events.
5. Alice refresh does not extend Bob’s expiry.
6. Deactivate Bob’s account; Bob cannot post; Alice can.
7. Exit 0 only if all assertions hold. Prints no message bodies to stdout.

Also `tests/hosted-drill.test.js` importing the drill function.

### Explicitly out of the drill
Real Clerk network, wrangler deploy, PITR API, DNS, live object name `invite-only-pilot`.

---

## 5. Cutover (human + Cloudflare; not automated here)

When John names the host:

1. Snapshot live schema-26 object; note PITR bookmark.
2. Clone storage; run this tree against the **clone**.
3. Confirm `/api/version`, Clerk issuer, `ship: false`, operator login.
4. Deploy Worker **code** in a separate step from any DO class migration (class changes cannot roll back).
5. Messaging env vars remain unset.

---

## 6. Collision / talk

- Grok: this tree, local commits only.
- Instinct: GitHub #11; dasha-lobby.
- Jill: bus `jill`; no keys in Muse chat.
- Claude Tag: Slack product-lab; `project-room-lab/` only.
- Occupancy: `git status --short` + board row.

---

## 7. Acceptance for this implementation

| Gate | Proof |
|---|---|
| Clerk fail-closed | `tests/production-gates.test.js` |
| Operator | `tests/provider-operator.test.js` |
| Journal backup | `tests/inbox-journal-backup.test.js` |
| Drill | `tests/hosted-drill.test.js` |
| MCP | `openJoinContract().ship === false` unchanged |
| Git | no push; no `.gitignore` / research docs / `.wrangler` |
