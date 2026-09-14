# Changelog

## 2026-09-14

- Room spend allowance (issue #6 C3): the owner records `room.spend_allowance_set`
  (`allowanceCents` over `periodDays`, or null to remove it) through
  `POST /api/rooms/:id/spend-allowance` (owner-only, 403 for everyone else) or the
  "Agent spend" card. `store.command()` refuses a `session.started` that would
  commit more than the allowance (`409 spend_allowance_exceeded`) and one that
  declares no `maxSpendCents` while an allowance is set
  (`422 spend_allowance_budget_required`); a live session reserves its declared
  cap until it stops, a stop below the cap frees the difference, and an attempt
  that closes without reporting spend holds its cap. `GET /api/rooms/:id/spend-allowance`
  and the card show allowance, spent, reserved, held and headroom from the same
  ledger (`spendLedger` in `src/work-item-session.js`). Docs: `docs/SESSION-BUDGETS.md`
  "Room spend allowance". Tests: `tests/spend-allowance.test.js`,
  `scripts/spend-allowance-browser-check.mjs`.

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
