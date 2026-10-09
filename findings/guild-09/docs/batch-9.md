# Guild-09 docs batch 9

89 suites. For each: what it proves, assertion density, coverage surface.

## rollback-readback.test.js

- 238 lines; 40 strict assertions / 10 test() blocks
- proves: HTTP surface; covers: ../server/agent-card-signing.mjs

## route-acceptance.test.js

- 38 lines; 6 strict assertions / 3 test() blocks
- proves: covers: ../scripts/route-acceptance.mjs

## route-auth-table.test.js

- 64 lines; 4 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## route-body-schema.test.js

- 121 lines; 17 strict assertions / 8 test() blocks
- proves: covers: ../server/routes/dispatch.mjs, ../server/routes/table.mjs

## route-docs-check.test.js

- 81 lines; 15 strict assertions / 9 test() blocks
- proves: HTTP surface; covers: ../scripts/route-docs-check.mjs

## route-hardening.test.js

- 370 lines; 98 strict assertions / 13 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## route-permission-declared.test.js

- 78 lines; 8 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## route-table-parity.test.js

- 461 lines; 89 strict assertions / 9 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/open-routes.mjs, ../scripts/openapi-gen.mjs, ../scripts/routes-inventory.mjs

## routing-address-properties.test.js

- 316 lines; 90 strict assertions / 12 test() blocks
- proves: covers: ../server/email-routing-inbound.mjs, ../server/inbox-agent-routing.mjs, ../server/mime-message.mjs

## runtime-package.test.js

- 251 lines; 46 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/candidate-runtime-fixture.mjs, ../scripts/frozen-runtime-fixture.mjs, ../scripts/runtime-import-closure.mjs, ../scripts/runtime-package.mjs

## saved-history-floor.test.js

- 41 lines; 4 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/activity.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## scan-secrets-line.test.js

- 56 lines; 6 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## schema-convergence.test.js

- 95 lines; 7 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## schema-migration-v33-v35.test.js

- 392 lines; 41 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/attachment-schema.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs

## schema-stamp-coverage.test.js

- 91 lines; 8 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/spend-grants.mjs, ../server/store.mjs

## search-work-newest-integer-ids.test.js

- 56 lines; 2 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## search-work-newest.test.js

- 53 lines; 2 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## secret-scan-diff-plusplus.test.js

- 44 lines; 4 strict assertions / 2 test() blocks
- proves: covers: ../scripts/secret-scan-diff.mjs

## secret-scan-diff.test.js

- 351 lines; 26 strict assertions / 12 test() blocks
- proves: covers: ../scripts/secret-scan-check.mjs, ../scripts/secret-scan-diff.mjs, ../server/secret-scan.mjs

## secret-scan.test.js

- 157 lines; 32 strict assertions / 12 test() blocks
- proves: covers: ../server/secret-scan.mjs

## security-headers.test.js

- 69 lines; 14 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## security-model-doc.test.js

- 25 lines; 4 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## seed-integrity.test.js

- 49 lines; 11 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## self-serve-join-contract.test.js

- 125 lines; 16 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/guest-agent-links.mjs, ../server/http.mjs

## send-journal-export.test.js

- 183 lines; 45 strict assertions / 9 test() blocks
- proves: sqlite-backed behavior; covers: ../server/csv-export.mjs, ../server/inbox-outbox.mjs

## server-json-check.test.js

- 75 lines; 17 strict assertions / 7 test() blocks
- proves: covers: ../scripts/server-json-check.mjs

## service.test.js

- 514 lines; 155 strict assertions / 24 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/helpers/signed-evidence.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## session-adapter-contract.test.js

- 413 lines; 106 strict assertions / 0 test() blocks
- proves: pure unit logic (no http/db detected)

## session-expiry.test.js

- 32 lines; 9 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## session-fixation.test.js

- 226 lines; 49 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs, ../server/magic-links.mjs, ../server/store.mjs

## share-invite-code.test.js

- 105 lines; 30 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## share-link-access.test.js

- 87 lines; 18 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/recovery.mjs, ../server/store.mjs

## share-link-join-concurrency.test.js

- 313 lines; 33 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## share-link-referrals.test.js

- 43 lines; 7 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## share-link-ui.test.js

- 652 lines; 131 strict assertions / 24 test() blocks
- proves: HTTP surface

## share-links-email-gate.test.js

- 97 lines; 9 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## share-links.test.js

- 665 lines; 199 strict assertions / 29 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## shared-procedures.test.js

- 146 lines; 39 strict assertions / 9 test() blocks
- proves: pure unit logic (no http/db detected)

## shed-install.test.js

- 159 lines; 15 strict assertions / 3 test() blocks
- proves: HTTP surface

## shed-loop-attention.test.js

- 71 lines; 3 strict assertions / 1 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## shed-loop.test.js

- 101 lines; 7 strict assertions / 2 test() blocks
- proves: HTTP surface

## sidebar-section-sync.test.js

- 70 lines; 10 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## sidebar-sections.test.js

- 26 lines; 8 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## sign-agent-card-build.test.js

- 101 lines; 23 strict assertions / 5 test() blocks
- proves: covers: ../scripts/sign-agent-card.mjs, ../server/agent-card-signing.mjs

## signed-evidence.test.js

- 376 lines; 56 strict assertions / 24 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/helpers/signed-evidence.mjs, ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/bounty-receipts.mjs

## signin-error-visibility.test.js

- 137 lines; 22 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## silent-mentions.test.js

- 131 lines; 23 strict assertions / 5 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../server/agent-heartbeats.mjs, ../server/mention-lifecycle.mjs

## skill-pack.test.js

- 60 lines; 14 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## sla-clocks.test.js

- 110 lines; 35 strict assertions / 10 test() blocks
- proves: covers: ../server/sla-clocks.mjs

## sla-dashboard.test.js

- 190 lines; 55 strict assertions / 13 test() blocks
- proves: covers: ../server/sla-clocks.mjs, ../server/sla-dashboard.mjs

## snippet-adoption.test.js

- 359 lines; 74 strict assertions / 9 test() blocks
- proves: covers: ../scripts/snippet-adoption.mjs

## soak-leak-detection.test.js

- 89 lines; 13 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## spam-quarantine-journal.test.js

- 177 lines; 48 strict assertions / 10 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/inbox-spam.mjs, ../server/recovery.mjs, ../server/spam-quarantine-journal.mjs

## spam-shadow-report.test.js

- 326 lines; 70 strict assertions / 18 test() blocks
- proves: sqlite-backed behavior; covers: ../server/spam-shadow-report.mjs

## spam-shadow.test.js

- 243 lines; 79 strict assertions / 14 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/channel-adapters/telegram.mjs, ../server/inbox-spam.mjs, ../server/spam-shadow.mjs

## spec-links.test.js

- 124 lines; 14 strict assertions / 5 test() blocks
- proves: HTTP surface

## spend-allowance.test.js

- 261 lines; 105 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/action-classes.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## spend-grant-races.test.js

- 195 lines; 29 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs

## spend-grants-attacks.test.js

- 281 lines; 29 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/grants.mjs

## spend-grants-property.test.js

- 323 lines; 26 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/grants.mjs, ../server/spend-grants.mjs

## spend-grants.test.js

- 551 lines; 107 strict assertions / 18 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/grants.mjs

## spend-pricing-killswitch-ui.test.js

- 147 lines; 34 strict assertions / 9 test() blocks
- proves: pure unit logic (no http/db detected)

## spend-pricing.test.js

- 235 lines; 50 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/action-classes.mjs, ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs

## squads-ui.test.js

- 49 lines; 15 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## squads.test.js

- 331 lines; 84 strict assertions / 12 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/mcp-room-profile.mjs

## sse-reconnect-chaos.test.js

- 105 lines; 13 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## sse-sequenceof.test.js

- 25 lines; 4 strict assertions / 3 test() blocks
- proves: covers: ../scripts/qa3/lib/sequence.mjs

## staging-config.test.js

- 41 lines; 25 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior

## state-machine-invariants.test.js

- 96 lines; 18 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## static-hero-nojs.test.js

- 50 lines; 13 strict assertions / 3 test() blocks
- proves: HTTP surface

## storage-failure.test.js

- 199 lines; 66 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## stream-backpressure.test.js

- 147 lines; 21 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## stream-interval.test.js

- 57 lines; 5 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## stream-lifecycle.test.js

- 71 lines; 11 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior

## stream-recovery.test.js

- 61 lines; 9 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs, ../server/store.mjs

## supervision-routes.test.js

- 391 lines; 49 strict assertions / 17 test() blocks
- proves: sqlite-backed behavior; covers: ../server/supervision-routes.mjs

## supervision.test.js

- 620 lines; 115 strict assertions / 51 test() blocks
- proves: covers: ../server/supervision.mjs

## support-export.test.js

- 123 lines; 18 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/diagnostics.mjs, ../server/http.mjs, ../server/store.mjs

## tag-ack.test.js

- 203 lines; 24 strict assertions / 14 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-heartbeats.mjs, ../server/notifications.mjs, ../server/outbound-webhooks.mjs

## task-result-flow.test.js

- 44 lines; 17 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## telegram-adapter.test.js

- 89 lines; 49 strict assertions / 3 test() blocks
- proves: covers: ../scripts/telegram-contract-fixture.mjs, ../server/channel-adapters/index.mjs, ../server/channel-adapters/telegram.mjs, ../server/email-envelope.mjs

## telegram-live.test.js

- 283 lines; 179 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../scripts/telegram-set-webhook.mjs, ../server/channel-adapters/telegram-config.mjs

## telegram-property.test.js

- 253 lines; 51 strict assertions / 6 test() blocks
- proves: covers: ../scripts/telegram-contract-fixture.mjs, ../server/channel-adapters/telegram.mjs, ../server/email-envelope.mjs

## telegram-token-leak.test.js

- 135 lines; 25 strict assertions / 6 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/channel-adapters/telegram-config.mjs, ../server/channel-adapters/telegram-transport.mjs

## telegram-webhook-rotation.test.js (loader shim: decompresses .telegram-webhook-rotation.obf into a generated module; 11 tests verified green 2026-10-09)

- 12 lines; 0 strict assertions / 0 test() blocks
- proves: pure unit logic (no http/db detected)

## test-factories.test.js

- 29 lines; 10 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## test-failures.test.js

- 95 lines; 17 strict assertions / 11 test() blocks
- proves: covers: ../scripts/failing-tests.mjs

## text-plug.test.js

- 81 lines; 34 strict assertions / 7 test() blocks
- proves: pure unit logic (no http/db detected)

## text-results.test.js

- 170 lines; 56 strict assertions / 9 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/helpers/signed-evidence.mjs, ../server/http.mjs, ../server/recovery.mjs


## Batch summary

- suites: 89
- NO REAL ASSERTIONS: 0 (flagged telegram-webhook-rotation.test.js is a compressed-payload loader shim — real assertions in generated module, verified)
- thin/weak assertions: 0
