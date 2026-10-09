# Guild-09 docs batch 5

89 suites. For each: what it proves, assertion density, coverage surface.

## guest-join.test.js

- 399 lines; 94 strict assertions / 18 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/guest-agent-links.mjs, ../server/guest-invites.mjs

## guest-scope-gate-http.test.js

- 209 lines; 16 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## guest-signout-ui.test.js

- 104 lines; 18 strict assertions / 4 test() blocks
- proves: HTTP surface

## guest-token-expiry.test.js

- 161 lines; 32 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/guest-agent-links.mjs, ../server/http.mjs, ../server/store.mjs

## guest-token-expiry.test.mjs

- 201 lines; 33 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/guest-invites.mjs, ../server/http.mjs

## handoff-case.test.js

- 103 lines; 18 strict assertions / 8 test() blocks
- proves: sqlite-backed behavior; covers: ../server/handoff-case.mjs, ../server/inbox-handoff.mjs

## handoff-envelope.test.js

- 258 lines; 46 strict assertions / 22 test() blocks
- proves: sqlite-backed behavior; covers: ../server/work-handoff.mjs

## handoff-receipt.test.js

- 117 lines; 33 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## handoff-renderer.test.js

- 218 lines; 62 strict assertions / 17 test() blocks
- proves: covers: ../server/work-handoff.mjs

## heartbeat-real-db-errors.test.js

- 43 lines; 8 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-heartbeats.mjs

## help-actions.test.js

- 98 lines; 35 strict assertions / 5 test() blocks
- proves: HTTP surface

## help-discovery.test.js

- 248 lines; 75 strict assertions / 8 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/frozen-runtime-fixture.mjs, ../scripts/helpers/signed-evidence.mjs, ../scripts/mcp-test-client.mjs

## help-mcp.test.js

- 106 lines; 35 strict assertions / 1 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/mcp-test-client.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## help-offer-context.test.js

- 226 lines; 75 strict assertions / 10 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs, ../server/store.mjs

## help-offer-service.test.js

- 220 lines; 47 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/frozen-runtime-fixture.mjs, ../scripts/runtime-package.mjs, ../server/autonomy-tiers.mjs

## help-offers.test.js

- 261 lines; 77 strict assertions / 17 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../server/recovery.mjs

## helper-agent-exercise.test.js

- 30 lines; 13 strict assertions / 1 test() blocks
- proves: covers: ../scripts/helper-agent-exercise.mjs, ../scripts/mcp-test-client.mjs

## herdr-backfill.test.js

- 270 lines; 68 strict assertions / 11 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/herdr-backfill.mjs

## herdr-bridge-adapter.test.js

- 933 lines; 145 strict assertions / 38 test() blocks
- proves: HTTP surface

## herdr-bridge-deploy.test.js

- 42 lines; 7 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## herdr-bridge.test.js

- 805 lines; 135 strict assertions / 49 test() blocks
- proves: HTTP surface

## herdr-migrate.test.js

- 451 lines; 132 strict assertions / 35 test() blocks
- proves: covers: ../scripts/herdr-migrate.mjs

## history-visibility.test.js

- 303 lines; 62 strict assertions / 8 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/history-visibility.mjs, ../server/http.mjs, ../server/recovery.mjs

## host-context-policy.test.js

- 59 lines; 13 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## host-policy-boundary.test.js

- 70 lines; 8 strict assertions / 5 test() blocks
- proves: HTTP surface

## host-process.test.js

- 108 lines; 28 strict assertions / 11 test() blocks
- proves: pure unit logic (no http/db detected)

## host-result.test.js

- 47 lines; 9 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## host-subprocess.test.js

- 15 lines; 3 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## host-verification.test.js

- 127 lines; 29 strict assertions / 10 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## http-public-dm.test.js

- 349 lines; 130 strict assertions / 13 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## human-404.test.js

- 72 lines; 20 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## human-onboarding-doors.test.js

- 59 lines; 9 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/http.mjs, ../server/store.mjs

## human-onboarding-nokey.test.js

- 100 lines; 13 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## human-push-display.test.js

- 34 lines; 13 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## human-push-preferences.test.js

- 208 lines; 28 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/routes/human-push.mjs, ../server/store.mjs

## human-push-ui.test.js

- 109 lines; 43 strict assertions / 7 test() blocks
- proves: pure unit logic (no http/db detected)

## human-push.test.js

- 299 lines; 62 strict assertions / 8 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs, ../server/web-push.mjs

## i18n-harness.test.js

- 208 lines; 35 strict assertions / 15 test() blocks
- proves: HTTP surface; covers: ../scripts/i18n-harness.mjs

## id-sec-http.test.js

- 235 lines; 46 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-rooms.mjs, ../server/http.mjs, ../server/magic-links.mjs

## identity-link-code.test.js

- 90 lines; 16 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-api-keys.mjs, ../server/http.mjs

## identity-mint-capacity.test.js

- 495 lines; 101 strict assertions / 9 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-identities.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/guest-invites.mjs

## identity-ratelimit.test.js

- 34 lines; 11 strict assertions / 3 test() blocks
- proves: covers: ../server/identity-ratelimit.mjs

## identity-verification.test.js

- 255 lines; 64 strict assertions / 13 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-card-signing.mjs, ../server/http.mjs, ../server/identity-verification.mjs

## inbox-adoption.test.js

- 80 lines; 29 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/inbox-result-fixture.mjs, ../server/backup.mjs, ../server/recovery.mjs

## inbox-agent-routing.test.js

- 99 lines; 39 strict assertions / 9 test() blocks
- proves: covers: ../server/inbox-agent-routing.mjs

## inbox-approval.test.js

- 100 lines; 31 strict assertions / 8 test() blocks
- proves: covers: ../server/inbox-approval.mjs

## inbox-assign.test.js

- 100 lines; 34 strict assertions / 9 test() blocks
- proves: covers: ../server/inbox-assign.mjs

## inbox-attachment-auth.test.js

- 117 lines; 30 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/graph-email.mjs, ../server/http.mjs

## inbox-attachments-quarantine.test.js

- 103 lines; 10 strict assertions / 4 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/graph-email.mjs, ../server/store.mjs

## inbox-attachments-routes.test.js

- 116 lines; 23 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/graph-email.mjs

## inbox-channel-client.test.js

- 104 lines; 36 strict assertions / 4 test() blocks
- proves: covers: ../scripts/telegram-contract-fixture.mjs

## inbox-client-read-validation.test.js

- 73 lines; 8 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## inbox-client.test.js

- 114 lines; 31 strict assertions / 7 test() blocks
- proves: pure unit logic (no http/db detected)

## inbox-collab-http.test.js

- 708 lines; 220 strict assertions / 14 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## inbox-collision.test.js

- 99 lines; 28 strict assertions / 8 test() blocks
- proves: covers: ../server/inbox-collision.mjs

## inbox-conversation-auth.test.js

- 139 lines; 28 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/graph-email.mjs, ../server/http.mjs

## inbox-digest-sla-routes.test.js

- 60 lines; 7 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/graph-email.mjs

## inbox-handoff.test.js

- 118 lines; 36 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior; covers: ../server/inbox-handoff.mjs

## inbox-import-guards.test.js

- 220 lines; 44 strict assertions / 12 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/channel-adapters/telegram.mjs, ../server/graph-email.mjs

## inbox-internal-notes.test.js

- 81 lines; 24 strict assertions / 8 test() blocks
- proves: covers: ../server/inbox-internal-notes.mjs

## inbox-outbox.test.js

- 254 lines; 94 strict assertions / 14 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/synthetic-mail-fixture.mjs, ../server/backup.mjs, ../server/http.mjs

## inbox-pagination.test.js

- 102 lines; 22 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs

## inbox-quarantine-coverage.test.js

- 191 lines; 46 strict assertions / 8 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/channel-adapters/telegram.mjs, ../server/http.mjs

## inbox-quarantine-durable.test.js

- 186 lines; 34 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/channel-adapters/telegram.mjs, ../server/graph-email.mjs

## inbox-quarantine-review.test.js

- 500 lines; 101 strict assertions / 26 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/channel-adapters/telegram.mjs, ../server/http.mjs, ../server/store.mjs

## inbox-quarantine-ui.test.js

- 31 lines; 12 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## inbox-quarantine-visibility.test.js

- 155 lines; 27 strict assertions / 9 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../server/channel-adapters/telegram.mjs, ../server/store.mjs

## inbox-read-state.test.js

- 112 lines; 44 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/store.mjs

## inbox-sandbox.test.js

- 16 lines; 6 strict assertions / 1 test() blocks
- proves: HTTP surface; covers: ../scripts/inbox-sandbox.mjs

## inbox-search-routes.test.js

- 119 lines; 28 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/graph-email.mjs

## inbox-search.test.js

- 45 lines; 10 strict assertions / 5 test() blocks
- proves: covers: ../server/inbox-search.mjs

## inbox-send-budget.test.js

- 96 lines; 16 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/channel-adapters/telegram-config.mjs, ../server/http.mjs

## inbox-send-ui.test.js

- 116 lines; 39 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## inbox-send.test.js

- 357 lines; 91 strict assertions / 25 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/channel-adapters/telegram-config.mjs, ../server/http.mjs, ../server/inbox-outbox.mjs

## inbox-spam-guard.test.js

- 200 lines; 49 strict assertions / 26 test() blocks
- proves: covers: ../server/inbox-spam.mjs

## inbox-spam.test.js

- 67 lines; 21 strict assertions / 8 test() blocks
- proves: covers: ../server/inbox-spam.mjs

## inbox-stitch-fuzz.test.js

- 69 lines; 4 strict assertions / 3 test() blocks
- proves: covers: ../server/inbox-stitch.mjs

## inbox-stitch.test.js

- 521 lines; 138 strict assertions / 22 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/channel-adapters/telegram.mjs, ../server/graph-email.mjs

## inbox-threads-replyindex.test.js

- 84 lines; 8 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/graph-email.mjs

## inbox-threads-routes.test.js

- 170 lines; 38 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/graph-email.mjs

## inbox-threads.test.js

- 80 lines; 20 strict assertions / 6 test() blocks
- proves: covers: ../server/inbox-threads.mjs

## inbox-triage.test.js

- 48 lines; 17 strict assertions / 5 test() blocks
- proves: covers: ../server/inbox-triage.mjs

## inbox-unified-routes.test.js

- 236 lines; 108 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/channel-adapters/telegram-config.mjs

## inbox-whatsapp-connection.test.js

- 60 lines; 18 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## inbox.test.js

- 152 lines; 57 strict assertions / 9 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/backup.mjs, ../server/http.mjs, ../server/recovery.mjs

## index-html-structure.test.js

- 72 lines; 6 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## install-sh.test.js

- 77 lines; 15 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## instance-lock.test.js

- 67 lines; 13 strict assertions / 5 test() blocks
- proves: covers: ../server/instance-lock.mjs

## integrity-incremental.test.js

- 91 lines; 23 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs


## Batch summary

- suites: 89
- NO REAL ASSERTIONS: 0
- thin/weak assertions: 0
