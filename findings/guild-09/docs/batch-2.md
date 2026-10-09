# Guild-09 docs batch 2

89 suites. For each: what it proves, assertion density, coverage surface.

## agent-work-search.test.js

- 168 lines; 64 strict assertions / 6 test() blocks
- proves: HTTP surface

## agent-work-sessions-http.test.js

- 96 lines; 17 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## agent-write-guide.test.js

- 187 lines; 54 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/helpers/signed-evidence.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## analytics-activation-funnel.test.js

- 215 lines; 42 strict assertions / 11 test() blocks
- proves: covers: ../server/analytics/activation-funnel.mjs

## analytics-attribution.test.js

- 41 lines; 17 strict assertions / 1 test() blocks
- proves: covers: ../server/analytics/attribution.mjs

## analytics-backfill.test.js

- 73 lines; 27 strict assertions / 3 test() blocks
- proves: covers: ../scripts/analytics-backfill.mjs, ../server/analytics/metrics.mjs, ../server/analytics/tail.mjs

## analytics-budget.test.js

- 55 lines; 9 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/analytics/tail.mjs, ../server/store.mjs

## analytics-catalog.test.js

- 61 lines; 12 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/analytics/catalog.mjs, ../server/analytics/schema.mjs

## analytics-context.test.js

- 47 lines; 23 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/analytics/context.mjs

## analytics-csv-export.test.js

- 26 lines; 8 strict assertions / 3 test() blocks
- proves: covers: ../server/csv-export.mjs

## analytics-dashboard-honesty.test.js

- 226 lines; 49 strict assertions / 12 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/analytics-backfill.mjs, ../server/analytics/dashboard-honesty.mjs, ../server/analytics/index.mjs

## analytics-derive.test.js

- 48 lines; 15 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/analytics/derive-tables.mjs, ../server/analytics/schema.mjs, ../server/analytics/tail.mjs

## analytics-export.test.js

- 60 lines; 13 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/analytics/export.mjs, ../server/analytics/schema.mjs

## analytics-map.test.js

- 99 lines; 29 strict assertions / 1 test() blocks
- proves: covers: ../server/analytics/map-room-event.mjs

## analytics-retention.test.js

- 33 lines; 8 strict assertions / 3 test() blocks
- proves: covers: ../server/retention.mjs

## analytics-sampling.test.js

- 59 lines; 12 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/analytics/metrics.mjs, ../server/analytics/retention.mjs, ../server/analytics/schema.mjs, ../server/analytics/tail.mjs

## analytics-tail.test.js

- 102 lines; 31 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/analytics/map-room-event.mjs, ../server/analytics/metrics.mjs, ../server/analytics/schema.mjs, ../server/analytics/tail.mjs

## anon-auth-before-validation.test.js

- 62 lines; 2 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## answer-engine-check.test.js

- 301 lines; 70 strict assertions / 6 test() blocks
- proves: covers: ../scripts/answer-engine-check.mjs

## asset-packaging.test.js

- 96 lines; 20 strict assertions / 8 test() blocks
- proves: HTTP surface

## assignment-watcher.test.js

- 379 lines; 115 strict assertions / 18 test() blocks
- proves: HTTP surface; covers: ../scripts/helpers/signed-evidence.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## attachments.test.js

- 58 lines; 12 strict assertions / 5 test() blocks
- proves: covers: ../server/attachments.mjs

## attention-read-budget.test.js

- 151 lines; 26 strict assertions / 6 test() blocks
- proves: HTTP surface; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## attention.test.js

- 91 lines; 26 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/action-classes.mjs, ../server/store.mjs

## audit-receipts.test.js

- 233 lines; 59 strict assertions / 23 test() blocks
- proves: pure unit logic (no http/db detected)

## audit-retention.test.js

- 33 lines; 7 strict assertions / 3 test() blocks
- proves: covers: ../server/audit-retention.mjs

## audit-wave-3b.test.js

- 277 lines; 34 strict assertions / 13 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-heartbeats.mjs, ../server/feedback-store.mjs, ../server/inbox-agent-routing.mjs, ../server/inbox-approval.mjs

## audit-wave-3c.test.js

- 304 lines; 35 strict assertions / 10 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## audit-wave-low-a.test.js

- 147 lines; 13 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/attachment-schema.mjs, ../server/inbox-attachment-bytes.mjs, ../server/inbox-spam.mjs, ../server/inbox-stitch-store.mjs

## audit-wave-low-b.test.js

- 169 lines; 11 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/dispute-arbiters.mjs, ../server/dm-consents.mjs, ../server/github-oauth.mjs

## audit-wave-low-c.test.js

- 256 lines; 23 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/next-actions.mjs, ../server/referral-invites.mjs, ../server/reputation.mjs, ../server/web-research.mjs

## audit-wave-low-d.test.js

- 331 lines; 36 strict assertions / 15 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/agent-onboard.mjs, ../scripts/deploy-checks.mjs, ../scripts/live-audit.mjs, ../scripts/room-key-pull.mjs

## audit2-channel-manage-touch.test.js

- 47 lines; 2 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## audit2-guest-hint-contrast.test.js

- 111 lines; 8 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## audit2-light-theme-surfaces.test.js

- 91 lines; 5 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## auth-signin-ui.test.js

- 305 lines; 74 strict assertions / 22 test() blocks
- proves: pure unit logic (no http/db detected)

## autonomy-tiers.test.js

- 267 lines; 61 strict assertions / 12 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## backlog.test.js

- 160 lines; 31 strict assertions / 9 test() blocks
- proves: pure unit logic (no http/db detected)

## backup-table-parity.test.js

- 97 lines; 6 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/backup.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## backup-verify.test.js

- 174 lines; 46 strict assertions / 14 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/backup-verify.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## begin-scope-retry.test.js

- 316 lines; 85 strict assertions / 7 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/mcp-test-client.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## begin-work.test.js

- 103 lines; 39 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## board-empty-copy.test.js

- 34 lines; 8 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## board-needs-me.test.js

- 91 lines; 31 strict assertions / 7 test() blocks
- proves: pure unit logic (no http/db detected)

## board-new-item.test.js

- 33 lines; 10 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## board-projection.test.js

- 56 lines; 21 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## board-ui-helpers.test.js

- 280 lines; 62 strict assertions / 25 test() blocks
- proves: pure unit logic (no http/db detected)

## board-waiting.test.js

- 42 lines; 10 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## board-wake-ready-work.test.js

- 171 lines; 42 strict assertions / 7 test() blocks
- proves: HTTP surface; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/routes/table.mjs, ../server/routes/wants-work.mjs

## board-wake.test.js

- 193 lines; 41 strict assertions / 6 test() blocks
- proves: HTTP surface; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## bonds-m3.test.js

- 146 lines; 21 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/autonomy-tiers.mjs, ../server/bonds.mjs, ../server/http.mjs

## bonds.test.js

- 461 lines; 132 strict assertions / 9 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-heartbeats.mjs, ../server/autonomy-tiers.mjs, ../server/bonds.mjs

## boot-config.test.js

- 139 lines; 39 strict assertions / 11 test() blocks
- proves: covers: ../scripts/sign-agent-card.mjs, ../server/agent-card-signing.mjs, ../server/boot-config.mjs

## bootstrap.test.js

- 37 lines; 13 strict assertions / 3 test() blocks
- proves: covers: ../server/bootstrap.mjs

## bounty-anti-flake.test.js

- 237 lines; 43 strict assertions / 9 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-approval-modes.test.js

- 193 lines; 25 strict assertions / 10 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-conservation-check.test.js

- 159 lines; 28 strict assertions / 8 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-disputes.test.js

- 221 lines; 55 strict assertions / 15 test() blocks
- proves: covers: ../server/bounty-disputes.mjs

## bounty-ensure-partial-migration.test.js

- 105 lines; 13 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-ensure-readonly.test.js

- 117 lines; 8 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-escrow-http.test.js

- 457 lines; 91 strict assertions / 12 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/autonomy-tiers.mjs, ../server/bounty-escrow.mjs, ../server/http.mjs

## bounty-escrow-release-probes.test.js

- 116 lines; 15 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-escrow-routes.test.js

- 342 lines; 66 strict assertions / 27 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bounty-escrow-routes.mjs, ../server/bounty-escrow.mjs

## bounty-escrow.test.js

- 670 lines; 195 strict assertions / 35 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-free-miss.test.js

- 357 lines; 85 strict assertions / 12 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/bounty-escrow.mjs, ../server/http.mjs

## bounty-idempotency-scope.test.js

- 265 lines; 36 strict assertions / 11 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-identity.test.js

- 341 lines; 46 strict assertions / 19 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs, ../server/bounty-reputation.mjs

## bounty-journal-replay.test.js

- 357 lines; 28 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-mcp-idempotency.test.js

- 288 lines; 62 strict assertions / 12 test() blocks
- proves: HTTP surface; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## bounty-receipts.test.js

- 547 lines; 136 strict assertions / 24 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs, ../server/bounty-receipts.mjs

## bounty-reputation.test.js

- 512 lines; 113 strict assertions / 20 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs, ../server/bounty-reputation.mjs, ../server/reputation.mjs

## bounty-review-packets.test.js

- 198 lines; 48 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-rubrics.test.js

- 239 lines; 38 strict assertions / 12 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-slug-collision.test.js

- 114 lines; 9 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-sybil-owner-canonical.test.js

- 93 lines; 7 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## bounty-sybil-route-owner-canonical.test.js

- 164 lines; 13 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bounty-escrow-routes.mjs, ../server/bounty-escrow.mjs

## bounty-sybil.test.js

- 505 lines; 109 strict assertions / 15 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/bounty-escrow.mjs, ../server/http.mjs

## bounty-tools.test.js

- 128 lines; 37 strict assertions / 14 test() blocks
- proves: covers: ../server/mcp-full-profile.mjs

## bounty-tracks.test.js

- 240 lines; 57 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs

## browser-session.test.js

- 106 lines; 40 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## browser-shards.test.js

- 115 lines; 31 strict assertions / 6 test() blocks
- proves: covers: ../scripts/browser-shards.mjs

## buyer-offer-http.test.js

- 118 lines; 16 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/record-rails-fixture.mjs

## buyer-signoff.test.js

- 101 lines; 15 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/record-rails-fixture.mjs

## candidate-manifest.test.js

- 88 lines; 15 strict assertions / 7 test() blocks
- proves: covers: ../scripts/candidate-manifest.mjs

## capabilities.test.js

- 88 lines; 19 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## capability-visibility.test.js

- 280 lines; 47 strict assertions / 9 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs

## channel-adapter-contracts.test.js

- 205 lines; 40 strict assertions / 9 test() blocks
- proves: covers: ../scripts/email-contract-fixture.mjs, ../scripts/gmail-contract-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/channel-adapters/email.mjs

## channel-connection.test.js

- 42 lines; 17 strict assertions / 2 test() blocks
- proves: covers: ../scripts/email-contract-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/channel-adapters/index.mjs, ../server/channel-connection.mjs

## channel-drain.test.js

- 195 lines; 63 strict assertions / 11 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/channel-drain.mjs, ../server/channel-import.mjs


## Batch summary

- suites: 89
- NO REAL ASSERTIONS: 0
- thin/weak assertions: 0
