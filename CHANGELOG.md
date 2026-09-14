# Changelog

## 2026-09-14

- Room lifecycle (issue #6 A2): schema 28 adds `rooms.archived_at` (migration
  backfills from the projection, idempotent, covered against genuine v27 data).
  `POST /api/account-rooms` creates a room for an account that already
  administers membership somewhere; the owner records `room.archived` and the
  room becomes read-only (reads, streams and export continue; commands, import
  and joins answer 409 `room_archived`); a member leaves with
  `member.access_changed` on themself without `manage_members`. Discovery
  carries `kind` (personal / organization badge until D1) and `archived`;
  the Rooms panel gains a New room form and lists archived rooms as read-only
  entries, never as working buttons; About offers Archive room (owner) and
  Leave room (member). `docs/ROUTE-AUTH-TABLE.md`, `docs/openapi.yaml`.

## 2026-09-12

- Agent autonomy: `client/room-agent.mjs` + `scripts/agent-inbox.mjs` CLI now wrap
  presence, capabilities, session claims, and work-session actions (#99).
- Docs: error taxonomy (`docs/ERROR-TAXONOMY.md`), OpenAPI 3.1 agent surface
  (`docs/openapi.yaml`), "Automate yourself" quickstart section,
  `deploy/install.sh` with parameterized systemd units.
- Security review: share-link token entropy, auth on mutating routes, CORS,
  XSS, path traversal, rate limits, secrets history — all clear
  (`docs/SECURITY-REVIEW-2026-09-12.md`).
- CI: `scripts/check.mjs` now syntax-checks `deploy/*.mjs`; upgrade gates give
  an actionable error on shallow clones.
- Load test: `scripts/load-test.mjs` — ~175 ops/sec plateau, p95 234–353ms,
  zero 500s; pilot bounds confirmed (100 members/room, 10k events).
- Backup drill: `scripts/backup-drill.mjs` proves the sqlite round-trip.
- Docs: `CONTRACT.md` (what the contract job enforces), `TESTING.md`,
  `AGENT-LANES.md`, architecture map in README, CI badge.
- Dasha: provider-coordination mapping (`docs/DASHA-PROVIDER-COORDINATION.md`),
  Done-chips spec, honest-empty UI principle (`docs/HONEST-EMPTY.md`).

## 2026-09-11

- Capability registry (#95), agent quickstart (#96), journey-coverage exact
  membership fix (#97), provisioned-key redaction (#98).
- Structural work-session claims: second driver gets 409, worker visible
  in presence (#93).
- Authenticated presence roster (#94).
