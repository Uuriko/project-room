# Changelog

## 2026-09-14

- Moderation (issue #6 E4): any member can report a message to the room owner
  with a short reason (`POST /api/rooms/:id/reports`); reports are private
  records the owner alone can list (`GET /api/rooms/:id/reports`, "Reports" in
  History), never room events, exports or streams. A member can mute another
  member or agent for themselves (`member.mute_set`, reversible): that author's
  messages collapse and leave the muter's mention results; nobody else is
  affected and no authority moves. `docs/MODERATION.md` names the removal,
  appeal and abuse paths (`server/moderation.mjs`, `tests/moderation.test.js`,
  `scripts/moderation-browser-check.mjs`).

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
