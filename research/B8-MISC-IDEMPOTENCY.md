# B8 — IDEMPOTENCY AUDIT: MISCELLANEOUS MUTATIONS

**Worker:** PRODUCT-200 reliability B8/50 (respawn; slice: admin / room-config /
member-perms / key-rotation / retention, everything not covered by B2–B7) · **Coordinator:**
`product200-reliability` · **Date:** 2026-10-08/09 · **Scope:** `server/` mutation
surface on `origin/main` @ `dbdd088bd`, read-only audit — no fixes.

**Slice boundary.** B2=work-claim, B3=invite/identity, B4=receipt/escrow/settle,
B5=messages/DMs/pins, B6=board, B7=membership. Ops that straddle (share-links,
agent-connections, access-requests) are covered here under member-perms with an
explicit B3/B7-overlap note so B1 can place them once.

**Severity scale.** P0 = data loss / double-charge / unauthorized duplicate.
P1 = duplicate side-effect with external visibility (lockout, duplicate
deliveries, orphan secrets). P2 = misleading error on retry, or silent
convergence with no way to detect a stale replay. P3 = cosmetic (journal
duplication).

**Headline: no P0 found in the misc slice.** 2 P1 findings (placebo
`requestId` on API-key rotation; no idempotency on webhook subscribe), 6 P2s.
The slice also contains the repo's two best idempotency exemplars, cited for
B11.

---

## Findings (P1/P2 first)

### P1-1 — API-key rotation accepts `requestId` but never uses it (placebo idempotency key)

- **Route:** `POST /api/agent-keys/:keyId/rotate` — `server/agent-plugin-routes.mjs:264-288`.
  The body shape explicitly allows `requestId` (`exact(data, ["confirm","requestId"])`,
  line 272), validates it (276-278), and **echoes it into the response**
  (line 287: `{ ...result, requestId: data.requestId }`) while the mutation
  path never reads it.
- **Mutation:** `store.agentPlugin.rotateApiKey` (`server/agent-plugin-store.mjs:434-442`)
  → `this.apiKeys.rotate(keyId)` (`server/agent-api-keys.mjs:135-145`), which
  mints a **new secret on every call** and discards the old one.
- **Failure mode:** client times out → retries with the same `requestId`
  (exactly what the route copy invites: *"requestId is optional"*, line 264) →
  server rotates a **second time**. Client holds the secret from the *first*
  rotation response it eventually receives (or none at all if both responses
  were lost) and has no way to know which rotation won → **self-lockout**.
- **Same pattern on issue:** `POST /api/agent-keys` (`routes.mjs:208-229`)
  accepts **no** `requestId` at all (`exact(data, ["scopes"...])`, line 212).
  Retry → second key row + second secret; the first secret is **shown once and
  unrecoverable** (hash-only storage, `agent-api-keys.mjs:98-123`; store
  persistence `agent-plugin-store.mjs:408-418`). Orphan keys accumulate in
  `agent_api_keys`.
- **Atomicity:** yes — `store.transaction()` wraps rotate/revoke (routes.mjs:280);
  `issueApiKey` runs inside `this.mutate()` (store.mjs:408). The hazard is
  replay, not torn writes.

### P1-2 — Webhook subscribe has no idempotency (no requestId, no client key)

- **Route:** `POST /api/agent-webhooks` — `server/agent-plugin-routes.mjs:448-496`.
  Accepted fields are exactly `url, events, secret?` (line 452); no `requestId`,
  no `subscriptionId`.
- **Mutation:** `store.agentPlugin.subscribeWebhook` (`server/agent-plugin-store.mjs:974-988`)
  calls `this.webhooks.subscribe({ agentId, url, events, secret })` **without a
  subscriptionId** — the pure module mints `newId()` per call
  (`server/agent-webhook-subscriptions.mjs:131-132`) and INSERTs a fresh row.
  (Note: the pure module *would* dedupe on a caller-supplied `subscriptionId`
  — `check(!subs.has(sid))`, line 133 — but the HTTP/store layer never passes
  one, so the natural key is unreachable from the wire.)
- **Failure mode:** client timeout → retry → **second subscription** →
  **duplicate deliveries of every room event** (one per subscription) to the
  same URL. The delivery journal (durable, pending→delivered/failed→dead_letter)
  records both as legit.
- **Atomicity:** yes (`this.mutate()` txn, store.mjs:975). Unsubscribe is
  converged-but-noisy: retry after success → 404 `unknown_subscription`
  (store.mjs:1012-1022) — P2.

### P2-1 — Re-issuing a capability/spend grant silently resurrects revoked grants

- `issueGrant` upserts with `revoked_at=NULL` reset
  (`server/grants.mjs:168-172`) — replaying an old issue request **after** a
  revoke silently un-revokes the grant, and there is **no requestId** on the
  route (`POST /api/rooms/:roomId/agent-grants`, grants.mjs ~264+) to bound
  which intent wins. `issueSpendGrant` is the same UPSERT
  (`server/spend-grants.mjs:308-318`; route `spend-grants.mjs:619-647`).
  Re-issue is convergent for identical terms, but a *stale* replay is
  indistinguishable from a fresh intent. Revoke itself is clean:
  `UPDATE ... WHERE revoked_at IS NULL`, returns `info.changes > 0`
  (grants.mjs:181-189) — idempotent, no-throw.

### P2-2 — Identity key-rotation route: misleading 409 on exact retry

- `POST /api/agent-identities/:id/keys/rotate` (`server/agent-plugin-routes.mjs:738-747`)
  accepts no `requestId` (body is exactly `{newPublicKey, overlapMs?}`).
  `rotateKey` (`server/agent-key-registry.mjs:103-132`) dedupes only via the
  natural key `(identity_id, public_key)` → an exact retry fails
  **409 `key_already_registered`** (misleading: the rotation *did* apply).
  A retry with freshly generated key material instead appends a **second
  rotation row** (chain bloat — harmless to verification since the registry is
  append-only, `keysFor` at registry:117-133). Revoke is the good twin:
  re-revoke is a **no-op returning the record** (registry:117-133).

### P2-3 — `createSquad`: no requestId; exact retry errors 409

- `createSquad` mints a fresh `squad_id` per call
  (`server/squads.mjs:185-218`); only the case-insensitive name check
  (409 `squad_exists`, line 206) prevents duplicates — so an exact retry gets
  a **misleading 409**, not a duplicate. `updateSquadMembers` is set-semantic
  and converges (squads.mjs:219-259); `disbandSquad` returns `{changed:false}`
  on re-disband (squads.mjs:261-275).

### P2-4 — Owner-delegate grant/revoke: converged, but retry errors

- `grant` (`server/owner-delegates.mjs:52-82`): no requestId; active-grant retry
  → 409 `grant_active`; re-grant-after-revoke UPDATEs the row **and appends a
  second journal row** (audit by design). `revoke` (85-110): retry after success
  → 404 `not_found` (misleading; state converged). Atomic via
  `store.transaction()`.

### P2-5 — Operator purge `requestId` is the server's internal operation id, not a client key

- `operatorRoutes` receives `{ requestId: operationId }`
  (`server/operator-routes.mjs:2748`) and threads it into `purge.plan/find/execute`.
  It is stored **as a label** in the `operator_actions` audit row
  (`server/operator-purge.mjs:323` etc.) — **no dedupe lookup exists**.
  A B1 reader seeing `request_id` in `operator_actions` could conclude
  idempotency exists; it does not. (The real replay protection is the
  **single-use signed confirm token**: `saved.used` → 409 `confirm_used`
  (operator-purge.mjs:397-399), plus recount-before-delete → 409
  `plan_changed` (403-404), single writer txn (402), and per-process ephemeral
  plan memory. Exemplar.)

### P3 — `recordRoomExport` journals a new event per call

- `server/history-visibility.mjs:146-148` emits `T.ROOM_EXPORTED` with a fresh
  `randomUUID()` event id — a retried export appends a duplicate journal row
  (harmless; export itself is a read).

---

## Idempotency matrix (misc slice)

Columns: **R** = requestId accepted · **D** = dedupe key + window · **Replay** =
safe on retry? · **A** = atomic? · **S** = severity of worst retry hazard.

| # | Op | Entry point | R | Dedupe key + window | Replay safe? | A | S |
|---|----|-------------|---|---------------------|--------------|---|---|
| 1 | API key issue | `POST /api/agent-keys` | ✗ not accepted | none | **No** — orphan key + lost secret | txn ✓ | P1 |
| 2 | API key rotate | `POST /api/agent-keys/:id/rotate` | ⚠ echo-only (routes.mjs:264-288) | none | **No** — re-rotates, client can't tell winner | txn ✓ | P1 |
| 3 | API key revoke | `POST /api/agent-keys/:id/revoke` | ⚠ echo-only | none (state converges) | converges, but retry errors 422 | txn ✓ | P2 |
| 4 | Identity key rotate | `POST /api/agent-identities/:id/keys/rotate` | ✗ | natural `(identity_id, public_key)` PK | exact retry → misleading 409; fresh key material → dup row | txn ✓ | P2 |
| 5 | Identity key revoke | `.../keys/revoke` | ✗ | row lookup | **Yes** — no-op returns record | txn ✓ | — |
| 6 | Webhook subscribe | `POST /api/agent-webhooks` | ✗ | none (fresh id minted) | **No** — duplicate subs → duplicate deliveries | txn ✓ | P1 |
| 7 | Webhook unsubscribe | `DELETE /api/agent-webhooks/:id` | n/a | id lookup | converges; retry → 404 | txn ✓ | P2 |
| 8 | Owner delegate grant | owner route → `OwnerDelegates.grant` | ✗ | 409 on active grant | converges; journal dups by design | txn ✓ | P2 |
| 9 | Owner delegate revoke | owner route → `OwnerDelegates.revoke` | ✗ | active-grant lookup | converges; retry → 404 | txn ✓ | P2 |
| 10 | Operator purge execute | `POST /api/operator/purge/execute` | ⚠ label only (internal op id) | single-use signed confirm token; 409 `confirm_used` | **Yes** | single txn ✓ | — |
| 11 | Operator purge plan/find | `.../purge/plan`, `.../purge/find` | ⚠ label only | n/a (read + audit row) | Yes | — | — |
| 12 | Capability grant issue | `POST /api/rooms/:r/agent-grants` | ✗ | UPSERT `(room,agent,capability)` — silent re-issue, clears `revoked_at` | converges; **stale replay resurrects** | txn ✓ | P2 |
| 13 | Capability grant revoke | `.../agent-grants` (revoke) | ✗ | `UPDATE … WHERE revoked_at IS NULL` | **Yes** (no-throw) | txn ✓ | — |
| 14 | Spend grant issue | `POST /api/rooms/:r/spend-grants` | ✗ | UPSERT terms | converges silently | txn ✓ | P2 |
| 15 | Spend grant revoke | `DELETE /api/rooms/:r/spend-grants/:agent` | ✗ | idempotent edge stamp | **Yes** | txn ✓ | — |
| 16 | Spend authorize | `chargeSpendBeforeCall` | nonce (required, ≤128) | UNIQUE `(room,agent,nonce)`; replay → settled:receipt / reserved:live auth / voided:409 | **Yes** (exemplar) | BEGIN IMMEDIATE txn ✓ | — |
| 17 | Autonomy tier set | `PUT /api/rooms/:r/operator/agents/:m` | ✗ | UPSERT `(room,member)` | **Yes** — naturally idempotent | txn ✓ | — |
| 18 | Room directory settings ×3 | (discoverable / opportunities / public_receipts) | ✗ | UPSERT `(room_id)` ×3 | **Yes** — naturally idempotent | ✓ | — |
| 19 | Room assistant ops | assistant `apply` | ✓ **required** | `room_assistant_ops(room,actor,requestId)` + canonical-input conflict → `assistant_retry_conflict` | **Yes** — replays stored response | txn ✓ | — |
| 20 | Wake enqueue/pause/resume/requeue | `WakeQueue.*` | ✓ **required** | `wake_queue_commands(room,member,requestId)`, immutable triggers, fingerprint 409 | **Yes** — exact retry at cap still served from receipt | txn ✓ | — |
| 21 | Attention prefs set | `Attention.set` | ✓ **required** | `private_attention_commands` receipt + UPSERT prefs | **Yes** | txn ✓ | — |
| 22 | Squad create | `createSquad` | ✗ | name-unique (case-insens) → 409 | converges; retry → misleading 409 | txn ✓ | P2 |
| 23 | Squad members update | `updateSquadMembers` | ✗ | set-semantics in-app | **Yes** — converges | txn ✓ | — |
| 24 | Squad disband | `disbandSquad` | ✗ | `{changed:false}` on re-disband | **Yes** | txn ✓ | — |
| 25 | Thread mute set | `ThreadMutes.set` | ✗ | `INSERT OR IGNORE` / `DELETE` | **Yes** — both ways | txn ✓ | — |
| 26 | Access-request decide | `AccessRequests.decide` | requestId identifies request | non-pending → 409 `already_decided`; already-member → closes w/o second grant | **Yes** | txn ✓ | — |
| 27 | Permission-request file | `MemberPermissionRequests.request` | ✓ (minted if omitted) | 409 `request_conflict` on reuse | **Yes** | txn ✓ | — |
| 28 | Room template apply | `applyRoomTemplate` | stable `tpl-<slug>-*` command ids | commands receipt via `store.command` | **Yes** | txn ✓ | — |
| 29 | All event-sourced room config¹ | `POST /api/rooms/:r/commands` | ✓ client `command.id` **required** | `commands(room,actor,id)` + sha256 fingerprint → 409 `idempotency_conflict`, `{duplicate:true}` | **Yes** | txn ✓ | — |
| 30 | Backup restore (`replayNdjson`) | operator/CLI | n/a | refuses existing store | one-shot; watermark-verified | single txn ✓ | — |
| 31 | Live-store retention run | cron | n/a | delete by `(idColumn, cutoff)` | **Yes** — replay is no-op | one txn per table ✓ | — |
| 32 | Operator audit append | internal | request_id stored as label | append-only SQL triggers | n/a | txn ✓ | — |
| 33 | Export journaling | `recordRoomExport` | n/a (fresh UUID) | none | dup journal rows (cosmetic) | txn ✓ | P3 |
| 34 | Notify-prefs setters | `createNotifyPrefs.*` | n/a (pure) | last-write-wins | n/a | n/a | — |

¹ Covers: `T.ROOM_CHARTER_UPDATED`, `T.ROOM_POLICY_SET`,
`T.ROOM_SPEND_ALLOWANCE_SET`, `T.ROOM_SPEND_PRICING_SET`, `T.ROOM_TRUST_SET`,
`T.ROOM_PUBLIC_RECEIPTS_SET`, `T.ROOM_JOIN_LINK_SET`, `T.ROOM_PUBLIC_PAGE_SET`,
`T.ROOM_HISTORY_VISIBILITY_SET`, `T.ROOM_ARCHIVED`, `T.ROOM_EXPORTED`
(`server/store.mjs:689-704`).

**Also scanned, no mutating writes:** `server/access-review.mjs` (read-only),
`server/backup.mjs` (pure digests/compare), `server/capability-visibility.mjs`,
`server/governance.mjs`, `server/supervision.mjs`, `server/deployment.mjs`,
`server/boot-config.mjs`, `server/recovery.mjs`, `server/required-reading.mjs`
(pure stamping), `server/csv-export.mjs`, `server/typing.mjs`, `server/web-push.mjs`,
`server/agent-fleet.mjs`, `server/agent-lanes.mjs`, `server/growth-experiments.mjs`
(in-memory defs), `server/purge-registry.mjs` (registry only), `server/room-lifecycle.mjs`
(migration UPDATE only).

---

## Recommended B11 candidates from this slice

1. **Fix the placebo `requestId` on key rotate/revoke** (P1-1): either wire
   `requestId` into a real dedupe store (receipt table keyed
   `(identity, keyId, requestId)` returning the stored `{secret}` on replay —
   *note:* the secret must be retained hashed or re-emitted from the receipt
   to be useful) or remove `requestId` from the accepted shape and the
   "optional" copy so clients don't rely on it. **Caveat for B11:** a receipt
   table that re-emits the *rotated secret* on replay extends secret lifetime —
   prefer returning 409 `confirm_used`-style on replay, or re-issuing a *new*
   rotation but returning the *same* secret the client already got... which is
   impossible without storing it. Flag: needs design, not just plumbing.
2. **Give `POST /api/agent-webhooks` idempotency** (P1-2): accept optional
   client `subscriptionId` (the pure module already supports it —
   `server/agent-webhook-subscriptions.mjs:122-133`) or a `requestId` receipt
   table; at minimum dedupe on `(agentId, url, events)` natural key.
3. **`POST /api/agent-keys`**: accept `requestId` and dedupe issuance the same
   way (P1-1's issue half).

## Open questions for B1

- `access-requests` / `share-links` / `agent-connections` / wake-queue ops sit
  on the B3/B7 boundary — included here as member-perms; B1 should assign each
  to exactly one slice to avoid double counting.
- Room export `ROOM_EXPORTED` journaling (P3) is cosmetic; flag only if B1
  counts journal pollution.

## File:line index (all findings)

- P1-1: `server/agent-plugin-routes.mjs:264-288` (placebo copy + echo),
  `server/agent-plugin-store.mjs:434-442`, `server/agent-api-keys.mjs:135-155`
  (rotate), `server/agent-plugin-routes.mjs:208-229` (issue, no requestId),
  `server/agent-plugin-store.mjs:408-418`.
- P1-2: `server/agent-plugin-routes.mjs:448-496`,
  `server/agent-plugin-store.mjs:974-988`,
  `server/agent-webhook-subscriptions.mjs:122-133`.
- P2-1: `server/grants.mjs:168-189`; `server/spend-grants.mjs:308-327,619-663`.
- P2-2: `server/agent-plugin-routes.mjs:738-757`;
  `server/agent-key-registry.mjs:103-133`.
- P2-3: `server/squads.mjs:185-275`.
- P2-4: `server/owner-delegates.mjs:52-110`.
- P2-5: `server/operator-routes.mjs:2748`; `server/operator-purge.mjs:361-462`
  (exemplar), `server/operator-actions.mjs:42-66`.
- P3: `server/history-visibility.mjs:146-148`.
- Exemplars: `server/store.mjs:4569-4600` (command receipt), `783-784`
  (id required), `server/http.mjs:4860-4871` (generic command route);
  `server/access-requests.mjs:169-208,624-732`;
  `server/member-permission-requests.mjs:37-82`;
  `server/share-links.mjs:277-328,400-406,448-451`;
  `server/wake-queue.mjs:145-255`; `server/room-assistant.mjs:62-130`;
  `server/attention.mjs:101-125`; `server/spend-grants.mjs:364-471`;
  `server/agent-connections.mjs:173-271`;
  `server/autonomy-tiers.mjs:119-132,226-240`;
  `server/room-directory.mjs:116-183`; `server/thread-mutes.mjs:100-142`;
  `server/retention-run.mjs:132-179`; `server/room-export.mjs:260-329`;
  `server/templates.mjs:138-204`.
