# Guild-09 docs batch 3

89 suites. For each: what it proves, assertion density, coverage surface.

## channel-import.test.js

- 316 lines; 158 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../scripts/synthetic-mail-fixture.mjs, ../scripts/telegram-contract-fixture.mjs

## channel-inbound-boot.test.js

- 48 lines; 5 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/boot-options.mjs, ../server/channel-import.mjs

## channel-journal-parity.test.js

- 138 lines; 22 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/channel-import.mjs, ../server/recovery.mjs

## channel-journal.test.js

- 202 lines; 75 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/channel-import.mjs, ../server/channel-journal.mjs

## channel-live-status.test.js

- 81 lines; 20 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/channel-adapters/telegram-config.mjs, ../server/channel-live-status.mjs, ../server/store.mjs

## channel-messenger-adapter.test.js

- 99 lines; 46 strict assertions / 4 test() blocks
- proves: covers: ../server/channel-adapters/index.mjs, ../server/channel-adapters/messenger.mjs, ../server/channel-connection.mjs

## channel-send-budgets.test.js

- 171 lines; 56 strict assertions / 15 test() blocks
- proves: covers: ../server/channel-adapters/telegram-config.mjs, ../server/channel-send-budgets.mjs, ../server/store.mjs, ../server/token-bucket.mjs

## channel-sender-cache.test.js

- 47 lines; 11 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../server/http.mjs

## channel-sms-adapter.test.js

- 101 lines; 46 strict assertions / 5 test() blocks
- proves: covers: ../server/channel-adapters/index.mjs, ../server/channel-adapters/sms.mjs, ../server/channel-connection.mjs

## channel-webhook-dedupe-property.test.js

- 166 lines; 15 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/channel-import.mjs

## chaos-drill.test.js

- 311 lines; 29 strict assertions / 0 test() blocks
- proves: HTTP surface; sqlite-backed behavior

## charter-audit-ownership.test.js

- 119 lines; 13 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/bootstrap.mjs, ../server/recovery.mjs, ../server/store.mjs

## chat-suggestions.test.js

- 73 lines; 28 strict assertions / 7 test() blocks
- proves: pure unit logic (no http/db detected)

## check-no-shadow-imports.test.js

- 91 lines; 3 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## checkpoint-channel-backfill.test.js

- 94 lines; 10 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/recovery.mjs, ../server/store.mjs

## ci-action-pinning.test.js

- 54 lines; 5 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## ci-changes.test.js

- 44 lines; 18 strict assertions / 6 test() blocks
- proves: covers: ../scripts/ci-changes.mjs

## ci-workflow-concurrency.test.js

- 239 lines; 24 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## claude-channel.test.js

- 168 lines; 31 strict assertions / 6 test() blocks
- proves: HTTP surface

## claude-plugin.test.js

- 45 lines; 10 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## cli-invite.test.js

- 37 lines; 10 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## client-stream.test.js

- 137 lines; 24 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## client.test.js

- 446 lines; 101 strict assertions / 28 test() blocks
- proves: pure unit logic (no http/db detected)

## cloudflare-platform-fakes.test.js

- 135 lines; 33 strict assertions / 3 test() blocks
- proves: HTTP surface

## code-drops-repair.test.js

- 169 lines; 19 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/code-drops.mjs, ../server/http.mjs, ../server/store.mjs

## code-drops.test.js

- 225 lines; 49 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/code-drops.mjs, ../server/http.mjs, ../server/store.mjs

## cold-start-budget.test.js

- 206 lines; 40 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/recovery-coverage.mjs, ../scripts/recovery-fixture.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## cold-start-friction.test.js

- 221 lines; 81 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs, ../server/mcp-http.mjs

## cold-start-probe.test.js

- 49 lines; 9 strict assertions / 2 test() blocks
- proves: HTTP surface

## composer-audience.test.js

- 14 lines; 3 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## composer-body-limit.test.js

- 38 lines; 8 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## composer-file-chip.test.js

- 24 lines; 4 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## composer-hint.test.js

- 52 lines; 8 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/http.mjs, ../server/store.mjs

## composer.test.js

- 23 lines; 5 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## concurrency-race.test.js

- 213 lines; 23 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## connect-snippets.test.js

- 64 lines; 18 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/build-agent-docs.mjs, ../server/connect-snippets.mjs, ../server/http.mjs, ../server/store.mjs

## connector-briefs.test.js

- 119 lines; 9 strict assertions / 1 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/helpers/signed-evidence.mjs, ../server/http.mjs

## contributing-doc.test.js

- 32 lines; 8 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## contribution-public.test.js

- 38 lines; 8 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## contribution-steps.test.js

- 102 lines; 37 strict assertions / 7 test() blocks
- proves: pure unit logic (no http/db detected)

## conversation-sync.test.js

- 248 lines; 65 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior

## conversation.test.js

- 356 lines; 146 strict assertions / 14 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## cookie-namespace.test.js

- 58 lines; 13 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## coverage-thresholds.test.js

- 325 lines; 50 strict assertions / 16 test() blocks
- proves: covers: ../scripts/coverage-thresholds.mjs

## credit-question.test.js

- 83 lines; 24 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## curiosity-rank.test.js

- 71 lines; 16 strict assertions / 5 test() blocks
- proves: covers: ../scripts/results-fixture.mjs

## curiosity-sort-mcp.test.js

- 82 lines; 16 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/mcp-test-client.mjs, ../scripts/results-fixture.mjs, ../server/http.mjs

## current-attention-integration.test.js

- 129 lines; 58 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/mcp-test-client.mjs, ../server/http.mjs

## current-attention.test.js

- 225 lines; 79 strict assertions / 14 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## cursor-guards.test.js

- 41 lines; 12 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## dasha-bridge.test.js

- 57 lines; 6 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## dead-route-removal.test.js

- 64 lines; 3 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## decision-register.test.js

- 94 lines; 16 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior

## decision-source.test.js

- 123 lines; 10 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/helpers/signed-evidence.mjs, ../server/autonomy-tiers.mjs

## delivery-tracing.test.js

- 290 lines; 83 strict assertions / 19 test() blocks
- proves: HTTP surface; covers: ../server/delivery-tracing.mjs

## demigod-contracts.test.js

- 113 lines; 16 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/record-rails-fixture.mjs

## demigod-jobs-money.test.js

- 414 lines; 76 strict assertions / 22 test() blocks
- proves: pure unit logic (no http/db detected)

## demigod-offers.test.js

- 136 lines; 23 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior

## dependency-audit.test.js

- 271 lines; 80 strict assertions / 22 test() blocks
- proves: covers: ../scripts/dependency-audit.mjs

## deploy-checks.test.js

- 540 lines; 128 strict assertions / 30 test() blocks
- proves: HTTP surface; covers: ../scripts/deploy-checks.mjs, ../scripts/deploy-recovery.mjs

## deploy-discovery.test.js

- 119 lines; 44 strict assertions / 9 test() blocks
- proves: covers: ../scripts/build-capabilities.mjs

## deploy-live.test.js

- 74 lines; 18 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## deployment-marker.test.js

- 61 lines; 12 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## deployment.test.js

- 106 lines; 40 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/backup.mjs, ../server/bootstrap.mjs, ../server/deployment.mjs, ../server/http.mjs

## design-tokens-css-sync.test.js

- 50 lines; 5 strict assertions / 3 test() blocks
- proves: covers: ../scripts/sync-design-tokens-css.mjs

## design-tokens-lint.test.js

- 151 lines; 46 strict assertions / 17 test() blocks
- proves: covers: ../scripts/lint-design-tokens.mjs

## design-tokens.test.js

- 71 lines; 3 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/room-health.mjs, ../server/public-face.mjs, ../server/public-read-model.mjs, ../server/receipts-page.mjs

## developer-contract.test.js

- 85 lines; 13 strict assertions / 6 test() blocks
- proves: HTTP surface; covers: ../scripts/route-docs-check.mjs

## diagnostics.test.js

- 171 lines; 55 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/diagnostics.mjs, ../server/http.mjs, ../server/store.mjs

## directory-card-seed.test.mjs

- 191 lines; 32 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## directory-card-withdrawal.test.js

- 100 lines; 12 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-card-signing.mjs, ../server/http.mjs

## disconnected-agent-roundtrip.test.js

- 136 lines; 20 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## discoverability.test.js

- 659 lines; 177 strict assertions / 15 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/audit-retention.mjs, ../server/bootstrap.mjs, ../server/discoverability.mjs

## discovery-profile.test.js

- 61 lines; 27 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## disk-door.test.js

- 91 lines; 23 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/disk-door.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## display-name-guard.test.js

- 203 lines; 49 strict assertions / 13 test() blocks
- proves: pure unit logic (no http/db detected)

## display-name-impersonation.test.js

- 244 lines; 75 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/display-name-guard.mjs, ../server/http.mjs

## dispute-arbiters.test.js

- 169 lines; 35 strict assertions / 11 test() blocks
- proves: covers: ../server/bounty-disputes.mjs, ../server/dispute-arbiters.mjs

## dm-consent-ui.test.js

- 197 lines; 63 strict assertions / 13 test() blocks
- proves: pure unit logic (no http/db detected)

## dm-consents-autonomy-tier.test.js

- 80 lines; 12 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## dm-consents.test.js

- 283 lines; 75 strict assertions / 14 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/dm-consents.mjs

## dm-follow-up-privacy.test.js

- 126 lines; 18 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## dm-nonparty-misc.test.js

- 52 lines; 9 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/activity.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## dm-privacy.test.js

- 250 lines; 51 strict assertions / 11 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## dm-reply-party.test.js

- 55 lines; 4 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## dm-thread-read-privacy.test.js

- 161 lines; 18 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## docs-architecture.test.js

- 179 lines; 11 strict assertions / 6 test() blocks
- proves: HTTP surface

## docs-glossary.test.js

- 66 lines; 5 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## docs-relative-links.test.js

- 37 lines; 1 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)


## Batch summary

- suites: 89
- NO REAL ASSERTIONS: 0
- thin/weak assertions: 0
