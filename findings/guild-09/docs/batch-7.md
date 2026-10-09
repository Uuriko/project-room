# Guild-09 docs batch 7

89 suites. For each: what it proves, assertion density, coverage surface.

## mention-receipts.test.js

- 112 lines; 25 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/mention-receipts.mjs, ../server/store.mjs

## mention-span.test.js

- 20 lines; 5 strict assertions / 2 test() blocks
- proves: covers: ../server/mention-lifecycle.mjs

## merge-hold.test.js

- 73 lines; 10 strict assertions / 4 test() blocks
- proves: covers: ../scripts/merge-hold.mjs

## merge-queue-eject-budget.test.js

- 283 lines; 64 strict assertions / 20 test() blocks
- proves: covers: ../scripts/merge-queue-eject-budget.mjs

## merge-queue.test.js

- 385 lines; 88 strict assertions / 20 test() blocks
- proves: covers: ../server/merge-queue.mjs

## message-delete-channel-copy.test.js

- 65 lines; 7 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## message-edit-delete.test.js

- 81 lines; 14 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## message-markdown.test.js

- 125 lines; 36 strict assertions / 23 test() blocks
- proves: pure unit logic (no http/db detected)

## message-posted-body.test.js

- 110 lines; 34 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs, ../server/store.mjs

## message-redaction.test.js

- 224 lines; 28 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/message-redaction.mjs

## message-thread.test.js

- 55 lines; 8 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## messages-backfill.test.js

- 269 lines; 77 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs, ../server/writer-fence.mjs

## messages-table.test.js

- 226 lines; 48 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/messages-store.mjs, ../server/store.mjs

## mime-fuzz.test.js

- 74 lines; 4 strict assertions / 3 test() blocks
- proves: covers: ../scripts/fuzz-mime.mjs

## mime-message.test.js

- 166 lines; 90 strict assertions / 10 test() blocks
- proves: covers: ../server/mime-message.mjs

## mint-budget-docs.test.js

- 44 lines; 8 strict assertions / 2 test() blocks
- proves: covers: ../server/agent-identities.mjs

## moderation-dm-privacy.test.js

- 76 lines; 13 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## moderation-report-autonomy-tier.test.js

- 52 lines; 4 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## moderation.test.js

- 246 lines; 80 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/action-classes.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## native-host-binary-resolution.test.js

- 114 lines; 23 strict assertions / 8 test() blocks
- proves: HTTP surface; covers: ../scripts/native-host-binary.mjs

## native-host-run-guards.test.js

- 29 lines; 5 strict assertions / 2 test() blocks
- proves: HTTP surface

## needs-attention-retry.test.js

- 476 lines; 68 strict assertions / 10 test() blocks
- proves: pure unit logic (no http/db detected)

## needs-me-open-work.test.js

- 260 lines; 60 strict assertions / 13 test() blocks
- proves: pure unit logic (no http/db detected)

## needs-me.test.js

- 103 lines; 11 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## next-actions.test.js

- 281 lines; 69 strict assertions / 16 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../server/next-actions.mjs

## node-jobs-health.test.js

- 60 lines; 19 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/jobs.mjs, ../server/store.mjs

## notification-feed.test.js

- 273 lines; 82 strict assertions / 12 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/notifications.mjs

## notification-preferences.test.js

- 72 lines; 12 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## notify-policy.test.js

- 219 lines; 60 strict assertions / 11 test() blocks
- proves: covers: ../server/notify-policy.mjs, ../server/notify-prefs.mjs

## notify-preferences.test.js

- 24 lines; 6 strict assertions / 2 test() blocks
- proves: covers: ../server/notify-prefs.mjs

## notify-quiet-hours.test.js

- 164 lines; 47 strict assertions / 19 test() blocks
- proves: covers: ../server/notify-prefs.mjs

## notify-relays.test.js

- 188 lines; 40 strict assertions / 7 test() blocks
- proves: HTTP surface; covers: ../server/channel-adapters/discord-webhook.mjs, ../server/channel-adapters/slack-webhook.mjs, ../server/channel-adapters/webhook-secret.mjs, ../server/notify-email.mjs

## oauth-authorize-http.test.js

- 238 lines; 53 strict assertions / 10 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs, ../server/magic-links.mjs

## oauth-consent-http.test.js

- 226 lines; 30 strict assertions / 6 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## oauth-persist.test.js

- 106 lines; 10 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/google-oauth.mjs, ../server/http.mjs

## oauth-provider-attack-cases.test.js

- 465 lines; 60 strict assertions / 14 test() blocks
- proves: covers: ../server/oauth-provider.mjs

## oauth-provider-durable.test.js

- 234 lines; 32 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs, ../server/magic-links.mjs, ../server/oauth-provider-store.mjs

## oauth-provider.test.js

- 339 lines; 76 strict assertions / 17 test() blocks
- proves: HTTP surface; covers: ../server/oauth-provider.mjs

## oauth-sessions-http.test.js

- 205 lines; 31 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## og-render.test.js

- 62 lines; 16 strict assertions / 4 test() blocks
- proves: covers: ../server/og-render.mjs

## onboarding-probe-docs.test.js

- 90 lines; 12 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/onboarding-probe/agent-docs.mjs, ../scripts/onboarding-probe/cleanup.mjs, ../scripts/onboarding-probe/lib.mjs, ../scripts/onboarding-probe/pow.mjs

## onboarding-probe-gate.test.js

- 65 lines; 16 strict assertions / 5 test() blocks
- proves: covers: ../scripts/onboarding-probe/gate.mjs

## onboarding-probe-predeploy.test.js

- 168 lines; 46 strict assertions / 9 test() blocks
- proves: HTTP surface; covers: ../scripts/onboarding-probe/predeploy.mjs

## onboarding-probe-report.test.js

- 106 lines; 12 strict assertions / 4 test() blocks
- proves: covers: ../scripts/onboarding-probe/docs-publish.mjs

## open-questions-ui.test.js

- 119 lines; 25 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## open-questions.test.js

- 141 lines; 20 strict assertions / 12 test() blocks
- proves: sqlite-backed behavior

## open-routes.test.js

- 155 lines; 28 strict assertions / 7 test() blocks
- proves: covers: ../scripts/open-routes.mjs

## openapi-415-documented.test.js

- 33 lines; 8 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../server/discoverability.mjs

## openapi-method-accuracy.test.js

- 76 lines; 20 strict assertions / 8 test() blocks
- proves: covers: ../scripts/open-routes.mjs, ../scripts/openapi-method-accuracy.mjs

## openapi-served-coverage.test.js

- 135 lines; 23 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/route-docs-check.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## operator-console-link.test.js

- 75 lines; 15 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## operator-purge.test.js

- 688 lines; 171 strict assertions / 19 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/http.mjs, ../server/operator-purge.mjs, ../server/operator-status.mjs, ../server/purge-registry.mjs

## operator-ui.test.js

- 48 lines; 12 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## opportunities-feed-v2.test.js

- 367 lines; 58 strict assertions / 11 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## orient-endpoint.test.js

- 127 lines; 34 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/http.mjs, ../server/orient.mjs, ../server/store.mjs

## otel-wiring.test.js

- 228 lines; 48 strict assertions / 8 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/bootstrap.mjs, ../server/channel-adapters/telegram-config.mjs, ../server/delivery-tracing.mjs

## outbound-webhooks.test.js

- 36 lines; 9 strict assertions / 3 test() blocks
- proves: covers: ../server/outbound-webhooks.mjs

## outside-agents.test.js

- 146 lines; 52 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs, ../server/outside-agents.mjs

## owed-replies.test.js

- 219 lines; 46 strict assertions / 9 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs, ../server/updates.mjs

## owner-attention.test.js

- 293 lines; 66 strict assertions / 11 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/helpers/signed-evidence.mjs, ../server/access-requests.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs

## owner-delegated-admin.test.js

- 148 lines; 17 strict assertions / 8 test() blocks
- proves: sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## owner-delegates.test.js

- 371 lines; 50 strict assertions / 15 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## owner-project-offers-ui.test.js

- 54 lines; 20 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## paid-work-offers.test.js

- 220 lines; 62 strict assertions / 12 test() blocks
- proves: covers: ../server/store.mjs

## passkey-login.test.js

- 671 lines; 118 strict assertions / 30 test() blocks
- proves: pure unit logic (no http/db detected)

## password-auth.test.js

- 126 lines; 42 strict assertions / 12 test() blocks
- proves: pure unit logic (no http/db detected)

## password-http.test.js

- 290 lines; 68 strict assertions / 13 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## password-reset-http.test.js

- 211 lines; 59 strict assertions / 8 test() blocks
- proves: HTTP surface; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/magic-links.mjs, ../server/store.mjs

## password-reset.test.js

- 77 lines; 9 strict assertions / 5 test() blocks
- proves: covers: ../server/bootstrap.mjs, ../server/store.mjs

## perf-budget.test.js

- 54 lines; 29 strict assertions / 3 test() blocks
- proves: covers: ../scripts/perf-budget.mjs

## perm-matrix-channel.test.js (thin: <1 strict assert per test)

- 135 lines; 5 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## persisted-row.test.js

- 194 lines; 44 strict assertions / 13 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bounty-escrow.mjs, ../server/persisted-row.mjs, ../server/work-claim-sqlite.mjs

## pilot-limits-single-source.test.js

- 59 lines; 9 strict assertions / 5 test() blocks
- proves: covers: ../server/store.mjs

## pinned-messages.test.js

- 281 lines; 98 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/action-classes.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## pins-dm-visibility.test.js

- 180 lines; 18 strict assertions / 9 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/pins.mjs, ../server/room-activation-pack.mjs, ../server/store.mjs

## pins-redacted-pin.test.js

- 68 lines; 7 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/message-redaction.mjs, ../server/pins.mjs, ../server/store.mjs

## polls.test.js

- 146 lines; 26 strict assertions / 10 test() blocks
- proves: pure unit logic (no http/db detected)

## portable-work.test.js

- 210 lines; 72 strict assertions / 13 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## pr-diff-size-check.test.js

- 140 lines; 21 strict assertions / 11 test() blocks
- proves: HTTP surface; covers: ../scripts/pr-diff-size-check.mjs

## pr-overlap.test.js

- 54 lines; 7 strict assertions / 4 test() blocks
- proves: covers: ../scripts/pr-overlap.mjs

## presence-states.test.js

- 276 lines; 58 strict assertions / 18 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## presence.test.js

- 84 lines; 18 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## private-history-stream.test.js

- 130 lines; 21 strict assertions / 6 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## probe-prod.test.js

- 123 lines; 28 strict assertions / 5 test() blocks
- proves: HTTP surface

## prod-deploy-smoke.test.js

- 210 lines; 25 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../server/agent-card-signing.mjs

## production-schema-compat.test.js

- 34 lines; 6 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/store.mjs, ../server/writer-fence.mjs

## project-offers-http.test.js

- 120 lines; 41 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior

## project-offers-raw-http.test.js

- 78 lines; 12 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior

## project-offers.test.js

- 101 lines; 21 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior


## Batch summary

- suites: 89
- NO REAL ASSERTIONS: 0
- thin/weak assertions: 1 — perm-matrix-channel.test.js
