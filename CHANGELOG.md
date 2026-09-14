# Changelog

## 2026-09-14

- Event streams (#6 E1 follow-up): the pump interval is configurable through
  `ROOM_STREAM_INTERVAL_MS` (integer 50-5000, validated at startup) and its
  default drops from 1000 ms to 250 ms, so delivery p50 falls from ~500 ms to
  ~125 ms at one read per stream per interval (`server/deployment.mjs`,
  `server/http.mjs`, `docs/SERVICE.md`).

- Room review policy (#6 A4 follow-up): the owner sets it from the Room
  instructions dialog (**Review policy**: none, independent review, owner
  decision, or both) instead of a hand-written `room.policy_set` command;
  members see the policy in force read only; both views follow live events and
  refusals stay inline (`src/room-instructions.js`,
  `scripts/room-policy-browser-check.mjs`).

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
