# Guild-09 docs batch 8

89 suites. For each: what it proves, assertion density, coverage surface.

## projection-at-rest.test.js

- 320 lines; 56 strict assertions / 17 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/conversation-sync.mjs, ../server/projection-at-rest.mjs, ../server/recovery.mjs

## projection-cache.test.js

- 93 lines; 18 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## proposed-by.test.js

- 420 lines; 56 strict assertions / 11 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/helpers/signed-evidence.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## provider-heartbeats.test.js

- 65 lines; 11 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## provision.test.js

- 153 lines; 35 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../server/store.mjs

## public-face.test.js

- 139 lines; 38 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior; covers: ../server/public-face.mjs, ../server/public-read-model.mjs, ../server/room-directory.mjs

## public-pages-hygiene.test.js

- 100 lines; 39 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/http.mjs, ../server/store.mjs

## public-read-model.test.js

- 336 lines; 72 strict assertions / 9 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/public-read-model.mjs, ../server/store.mjs

## public-receipts-toggle.test.js

- 153 lines; 41 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/receipts-live.mjs, ../server/store.mjs

## public-search-http.test.js

- 222 lines; 79 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/http.mjs, ../server/store.mjs

## public-work-match-http.test.js

- 81 lines; 24 strict assertions / 3 test() blocks
- proves: HTTP surface

## public-work-mcp.test.js

- 169 lines; 89 strict assertions / 9 test() blocks
- proves: HTTP surface

## public-work-owner-projection.test.js

- 28 lines; 5 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior

## public-work-review-schema.test.js

- 63 lines; 12 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior

## public-work-reviews-http.test.js

- 125 lines; 46 strict assertions / 6 test() blocks
- proves: HTTP surface

## public-work-reviews.test.js

- 228 lines; 92 strict assertions / 12 test() blocks
- proves: sqlite-backed behavior

## public-work-stranger-journey.test.js

- 110 lines; 24 strict assertions / 2 test() blocks
- proves: HTTP surface

## public-work-successor-http.test.js

- 95 lines; 27 strict assertions / 4 test() blocks
- proves: HTTP surface

## public-work-successors.test.js

- 96 lines; 53 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior

## pull-only-heartbeat-wakes.test.js

- 119 lines; 20 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## push-subscriptions.test.js

- 328 lines; 60 strict assertions / 14 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/push-subscriptions.mjs, ../server/store.mjs, ../server/web-push.mjs

## push-sw.test.js

- 156 lines; 23 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## pwa-icons.test.js

- 59 lines; 23 strict assertions / 3 test() blocks
- proves: covers: ../server/human-push.mjs

## pwa-install.test.js

- 47 lines; 21 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## qa200-reg12-openapi-parity.test.js

- 54 lines; 13 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## qa4-legal-door-alias.test.js

- 60 lines; 7 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/legal-pages.mjs, ../server/store.mjs

## qa4-orient-visibility.test.js

- 58 lines; 6 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## qa5-agent-errors.test.js

- 46 lines; 18 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../server/mcp-arg-errors.mjs, ../server/mcp-http.mjs, ../server/mcp-public-work.mjs

## qa5-docs-code-a11y.test.js

- 37 lines; 11 strict assertions / 3 test() blocks
- proves: covers: ../scripts/build-agent-docs.mjs

## qa5r-board-nav-style.test.js

- 30 lines; 9 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## qa5r-mcp-public-work-suggest.test.js

- 28 lines; 6 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../server/mcp-http.mjs

## qa8-guest-history-copy.test.js

- 34 lines; 8 strict assertions / 3 test() blocks
- proves: covers: ../server/share-links.mjs

## qa8-guest-invite-history-copy.test.js

- 78 lines; 15 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/guest-agent-links.mjs, ../server/history-visibility.mjs, ../server/store.mjs

## qa8-message-body-controls.test.js

- 43 lines; 5 strict assertions / 2 test() blocks
- proves: covers: ../server/store.mjs

## quarantine-review-coverage.test.js

- 224 lines; 59 strict assertions / 11 test() blocks
- proves: sqlite-backed behavior; covers: ../server/quarantine-review-coverage.mjs

## quickstarts-docs.test.mjs

- 159 lines; 35 strict assertions / 9 test() blocks
- proves: pure unit logic (no http/db detected)

## ralph-loop.test.js

- 398 lines; 89 strict assertions / 0 test() blocks
- proves: pure unit logic (no http/db detected)

## rate-limit.test.js

- 57 lines; 11 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## read-cursor-unify.test.js

- 79 lines; 27 strict assertions / 9 test() blocks
- proves: covers: ../server/read-cursor.mjs

## read-redaction.test.js

- 136 lines; 22 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## rebuild-determinism.test.js

- 128 lines; 8 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## rebuild-stale-checkpoint.test.js

- 66 lines; 5 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/recovery.mjs, ../server/store.mjs

## receipt-prose-quality.test.js

- 184 lines; 36 strict assertions / 7 test() blocks
- proves: covers: ../scripts/merge-queue-receipt.mjs

## receipt-search.test.js

- 296 lines; 86 strict assertions / 11 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs, ../server/work-claim-routes.mjs

## receipts-live-filter.test.js

- 178 lines; 26 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/receipts-live.mjs, ../server/store.mjs

## receipts-route.test.js

- 112 lines; 34 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/receipts-live.mjs, ../server/store.mjs

## recipe-preview.test.js

- 89 lines; 27 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## recovery-audit-sweep.test.js

- 344 lines; 3 strict assertions / 3 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../server/access-requests.mjs, ../server/autonomy-tiers.mjs, ../server/recovery.mjs

## recovery-codes-http.test.js

- 220 lines; 32 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## recovery-comparison.test.js

- 225 lines; 81 strict assertions / 14 test() blocks
- proves: sqlite-backed behavior

## recovery-retired-tables.test.js

- 44 lines; 1 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/recovery.mjs, ../server/store.mjs

## recovery.test.js

- 291 lines; 101 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/recovery-coverage.mjs, ../scripts/recovery-fixture.mjs, ../server/backup.mjs, ../server/http.mjs

## referral-board.test.js

- 52 lines; 10 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## referral-invites.test.js

- 525 lines; 144 strict assertions / 17 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/agent-identities.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs

## referrals.test.js

- 286 lines; 57 strict assertions / 12 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## regex-parity.test.js

- 71 lines; 4 strict assertions / 3 test() blocks
- proves: covers: ../scripts/claims-index.mjs, ../server/claim-validate.mjs

## rel14-backup-bytes.test.js

- 135 lines; 19 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/backup-verify.mjs, ../server/backup.mjs, ../server/bootstrap.mjs, ../server/room-export.mjs

## relay-pause-minutes.test.js

- 16 lines; 1 strict assertions / 1 test() blocks
- proves: covers: ../machine/lib/protocol.mjs

## release-checkpoint.test.js

- 220 lines; 54 strict assertions / 11 test() blocks
- proves: HTTP surface; covers: ../scripts/release-checkpoint.mjs

## release-evidence-cli.test.js

- 78 lines; 12 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## release-evidence.test.js

- 70 lines; 24 strict assertions / 9 test() blocks
- proves: HTTP surface; covers: ../scripts/release-evidence.mjs

## release-service.test.js

- 52 lines; 8 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## reminders.test.js

- 208 lines; 65 strict assertions / 13 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/helpers/signed-evidence.mjs, ../server/http.mjs, ../server/reminders.mjs

## reply-actions.test.js

- 45 lines; 6 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## reply-agent.test.js

- 835 lines; 231 strict assertions / 37 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/mcp-test-client.mjs, ../server/agent-rooms.mjs, ../server/http.mjs

## reply-composer.test.js

- 119 lines; 31 strict assertions / 9 test() blocks
- proves: pure unit logic (no http/db detected)

## reply-request-audit-edits.test.js

- 134 lines; 12 strict assertions / 10 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/recovery.mjs, ../server/store.mjs

## reply-request-audit-ownership.test.js

- 80 lines; 10 strict assertions / 3 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../server/recovery.mjs

## reply-requests.test.js

- 587 lines; 166 strict assertions / 25 test() blocks
- proves: HTTP surface; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## report-test-failures.test.js

- 137 lines; 44 strict assertions / 8 test() blocks
- proves: covers: ../scripts/browser-ci.mjs, ../scripts/report-test-failures.mjs

## reputation.test.js

- 36 lines; 8 strict assertions / 3 test() blocks
- proves: covers: ../server/reputation.mjs

## request-access-door.test.js

- 134 lines; 30 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## request-attention.test.js

- 204 lines; 77 strict assertions / 11 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## required-reading.test.js

- 204 lines; 45 strict assertions / 12 test() blocks
- proves: sqlite-backed behavior; covers: ../server/required-reading.mjs, ../server/work-claim-routes.mjs, ../server/work-claim-sqlite.mjs, ../server/work-claims.mjs

## resend-mailer.test.js

- 138 lines; 41 strict assertions / 11 test() blocks
- proves: covers: ../server/magic-links.mjs, ../server/resend-mailer.mjs

## restore-reconciliation.test.js

- 20 lines; 4 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## result-copy.test.js

- 101 lines; 30 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/helpers/signed-evidence.mjs, ../server/http.mjs

## result-diff.test.js

- 39 lines; 9 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## result-evidence.test.js

- 97 lines; 26 strict assertions / 11 test() blocks
- proves: pure unit logic (no http/db detected)

## retention-live-store.test.js

- 95 lines; 31 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/retention-run.mjs, ../server/store.mjs

## retention-run.test.js

- 78 lines; 29 strict assertions / 4 test() blocks
- proves: covers: ../server/retention-run.mjs

## retention-ui.test.js

- 170 lines; 26 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## return-brief-client.test.js

- 192 lines; 48 strict assertions / 14 test() blocks
- proves: pure unit logic (no http/db detected)

## return-brief.test.js

- 328 lines; 101 strict assertions / 16 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/helpers/signed-evidence.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## review-annotations.test.js

- 27 lines; 6 strict assertions / 4 test() blocks
- proves: covers: ../scripts/review-mechanical-report.mjs

## review-mechanical-report.test.js

- 168 lines; 47 strict assertions / 7 test() blocks
- proves: covers: ../scripts/review-mechanical-report.mjs

## review-scope-check.test.js

- 109 lines; 25 strict assertions / 12 test() blocks
- proves: covers: ../scripts/review-scope-check.mjs

## review-state.test.js

- 116 lines; 20 strict assertions / 10 test() blocks
- proves: pure unit logic (no http/db detected)

## rich-push.test.js

- 310 lines; 71 strict assertions / 13 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/push-subscriptions.mjs, ../server/store.mjs


## Batch summary

- suites: 89
- NO REAL ASSERTIONS: 0
- thin/weak assertions: 0
