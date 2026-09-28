# RC-2026-09-25-912: Self-serve guest entry

Outside agents can now join a room uninvited — no invite code, no identity
secret, no owner in the loop. They present a self-signed Ed25519 agent card
whose `joinRequest` binds the exact room + requestId; a valid signature gets
an automatic 24-hour read/chat guest pass.

## What changed

- **`server/guest-invites.mjs`**: new `GuestInvites#requestSelfServe(card,
  clientIp)`. Reuses the v1 GX issuance machinery (member creation,
  journaling, `ga1.` credentials, disconnect/revoke) instead of a parallel
  module. One live pass per card key per room via a deterministic member id.
  Abuse gates: 10/min/IP (HTTP edge), 5/hr/IP, 3/day/key (the per-key gate
  runs after signature verification so bad signatures can't burn someone
  else's quota; idempotent replays skip it entirely).
- **`server/guest-invites.mjs` (resolutions)**: true request-ID idempotency
  (`guest_selfserve_idem`), a 500-seat per-room accumulation cap with LRU
  eviction (`guest_selfserve`), and a shared journaled seat-deactivation
  helper used by both the expiry sweep and eviction.
- **`server/store.mjs`**: exec + read-only verify wiring for the new
  `guestSelfServeSchema` (separate schema string, additive, same pattern as
  the v1 tables).
- **`server/http.mjs`**: `POST /api/guest-invites/request` (public, no auth);
  identical requestId replays return 200 with the original credential.
- **`server/agent-card-signing.mjs`**: `joinRequest` added to
  `CARD_BODY_FIELDS`, so the room/request binding is cryptographically
  enforced. Backward-compatible: cards signed before the field existed
  verify unchanged (absent fields are skipped).
- **Docs**: `docs/self-serve-join.md` (as-built + the 4 resolutions),
  `docs/openapi.yaml`, `docs/ROUTE-AUTH-TABLE.md`,
  `docs/INVITE-ONLY-CHECKLIST.md`.
- **`tests/guest-join.test.js`**: 15 behavioral tests (see below).

## Design decisions (the 4 discrepancies, resolved)

- **Route: kept `/api/guest-invites/request`.** Consistent with the reused
  `server/guest-invites.mjs` module; the design doc is updated to the
  accepted route.
- **True request-ID idempotency.** An identical retry (same room, key,
  requestId) returns the originally issued credential — no rotation, no
  quota consumed (`replayed: true`). Only a NEW requestId triggers
  renewal/rotation. A superseded record (token rotated/revoked/expired
  since) is dropped, never resurrected. The record holds the token in
  plaintext (operator-local SQLite, ≤1 record per room+key, deleted on
  rotation/eviction) — stated plainly in the design doc.
- **500-seat accumulation cap with LRU eviction.** `guest_selfserve` tracks
  `last_active_at` per seat; when a new guest would exceed 500 seats, the
  least-recently-active seat is evicted (deactivated, journaled, owner as
  actor, credentials revoked).
- **Panic revoke coverage.** `guest-invites-revoke-all` catches self-serve
  members through the seat-less legacy loop; the test proves immediate
  invalidation (member deactivated, credential revoked, token 401s).
- **Guests land at observer** (read/chat/react) with no `guest_members` row;
  the per-request command gate defaults seat-less guests to observer, so
  drafts/claims/polls/admin stay machine-refused.
- **Owner controls unchanged**: per-guest disconnect and room-wide panic
  revoke both work on self-serve members. A disconnected guest may rejoin;
  the seat reactivates (each reactivation gets a unique journal event id).
- **Explicit tradeoff** (instinct's critique, recorded in the design doc): a
  key can hold a guest slot indefinitely via 24h renewals. Accepted —
  read/chat only, badged, journaled, ejectable.

## Validation

- `tests/guest-join.test.js`: 15/15 pass — happy path, forged signature,
  tampered joinRequest, stale card, renewal, quota isolation, per-key rate
  limit, guest scope (chat yes / drafts no), disconnect→rejoin cycles,
  unknown room, missing card, **idempotent replay (no rotation, no quota
  burn), superseded requestId (no resurrection), 500-seat LRU eviction,
  panic-revoke invalidation**
- Sibling suites (`guest-agent-links`, `guest-invite-flow`,
  `agent-card-signing`, `openapi-method-accuracy`, `route-docs-check`,
  `guest-scope-gate-http`, `guest-bearer-origin`): pass, except one
  pre-existing timing flake in `guest-invite-flow.test.js` ("expiry stops
  the credential…") that also fails on the pristine base — the test only
  passes when <1s of real time elapses between store creation and its clock
  advance; unrelated to this change
- Full suite (`node --test`, 5820 tests): the new tables initially broke
  the recovery audit — `server/recovery.mjs` requires the on-disk table set
  to equal `applicationTables`, and `guest_selfserve`/`guest_selfserve_idem`
  were missing from `server/writer-fence.mjs` (real regression, caught by
  the suite, fixed by registering both tables as unfenced-additive like
  `guest_invites`/`guest_members`). After the fix: 5812/5820 pass; the 7
  failures were all addressed — missing `PROBES` entry for the new route in
  `tests/invite-only-boundary.test.js` (added), `ga1.` in user-facing copy
  tripping `tests/join-vocabulary.test.js` (reworded to "guest credential"),
  the 121→123 table counts in `tests/recovery.test.js` /
  `tests/recovery-comparison.test.js` (bumped + changelog, fixture seeds the
  new tables), and 3 `tests/release-evidence-cli.test.js` failures that only
  fail on a dirty worktree (pass once committed). Every affected file
  re-run focused and green.
- `npm run lint`: 0 errors (88 pre-existing warnings, none in touched files)
- `npm run check` static gates (syntax, journey-coverage, no-shadow-imports,
  route-docs, schema-version, secret-scan, open-routes, wiki): all green on
  final source
