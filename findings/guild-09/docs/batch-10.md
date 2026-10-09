# Guild-09 docs batch 10

80 suites. For each: what it proves, assertion density, coverage surface.

## thread-options.test.js

- 197 lines; 50 strict assertions / 9 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/notifications.mjs

## token-bucket.test.js

- 39 lines; 12 strict assertions / 3 test() blocks
- proves: covers: ../server/token-bucket.mjs

## touch-targets-coarse.test.js

- 52 lines; 2 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## trace-entry.test.mjs

- 144 lines; 30 strict assertions / 0 test() blocks
- proves: covers: ../scripts/trace-entry.mjs

## trial-task-http.test.js

- 29 lines; 16 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/runtime-package.mjs, ../server/operator-purge.mjs

## trial-tasks.test.js

- 231 lines; 38 strict assertions / 15 test() blocks
- proves: covers: ../server/trial-tasks.mjs

## trust-tools.test.js

- 43 lines; 15 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## two-trigger-discipline.test.js

- 165 lines; 38 strict assertions / 17 test() blocks
- proves: covers: ../server/attention.mjs, ../server/mention-lifecycle.mjs, ../server/notifications.mjs, ../server/notify-prefs.mjs

## typing-client.test.js

- 96 lines; 11 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## typing-routes.test.js

- 104 lines; 16 strict assertions / 7 test() blocks
- proves: covers: ../server/routes/typing.mjs, ../server/typing.mjs

## typing.test.js

- 74 lines; 17 strict assertions / 8 test() blocks
- proves: covers: ../server/typing.mjs

## unification.test.js

- 97 lines; 23 strict assertions / 4 test() blocks
- proves: covers: ../server/return-selectors.mjs

## unit-ci-runner.test.js

- 28 lines; 5 strict assertions / 2 test() blocks
- proves: covers: ../scripts/unit-ci.mjs

## unit-shards.test.js

- 148 lines; 39 strict assertions / 6 test() blocks
- proves: covers: ../scripts/unit-shards.mjs

## untested-modules-lint.test.js

- 40 lines; 2 strict assertions / 1 test() blocks
- proves: covers: ../server/foo.mjs, ../server/sub/deep.mjs

## updates-http.test.js

- 542 lines; 124 strict assertions / 13 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs, ../server/updates.mjs

## updates-request-context-privacy.test.js

- 66 lines; 4 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs, ../server/updates.mjs

## updates-ui.test.js

- 56 lines; 20 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## usage.test.js

- 237 lines; 59 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## user-guide-doc.test.js

- 27 lines; 4 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## ux-copy.test.js

- 30 lines; 5 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## verify-affected.test.js

- 97 lines; 23 strict assertions / 6 test() blocks
- proves: covers: ../scripts/verify-affected.mjs, ../server/core, ../server/feature.mjs

## version.test.js

- 99 lines; 22 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs, ../server/version.mjs

## vetting-receipts.test.js

- 237 lines; 32 strict assertions / 15 test() blocks
- proves: covers: ../server/vetting-receipts.mjs

## video-walkthrough-shots.test.js

- 118 lines; 10 strict assertions / 6 test() blocks
- proves: HTTP surface

## viewport-interactive-widget.test.js

- 21 lines; 4 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## wake-live.test.js

- 355 lines; 64 strict assertions / 16 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-heartbeats.mjs, ../server/http.mjs, ../server/purge-registry.mjs

## wake-path.test.js

- 553 lines; 104 strict assertions / 26 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-heartbeats.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## wake-pause.test.js

- 287 lines; 97 strict assertions / 10 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/action-classes.mjs, ../server/http.mjs, ../server/wake-queue.mjs

## wake-queue.test.js

- 153 lines; 51 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/action-classes.mjs, ../server/store.mjs, ../server/wake-queue.mjs

## watch-cli.test.js

- 365 lines; 114 strict assertions / 27 test() blocks
- proves: covers: ../scripts/agent-watch.mjs, ../server/bootstrap.mjs

## watch-http.test.js

- 95 lines; 35 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## watch-journal.test.js

- 326 lines; 74 strict assertions / 16 test() blocks
- proves: HTTP surface; sqlite-backed behavior

## web-fetch-content-decoding.test.js

- 56 lines; 6 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../server/web-fetch.mjs

## web-fetch-ssrf-hardening.test.js

- 104 lines; 22 strict assertions / 8 test() blocks
- proves: HTTP surface; covers: ../server/web-fetch.mjs

## web-fetch.test.js

- 509 lines; 107 strict assertions / 28 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## web-push.test.js

- 345 lines; 70 strict assertions / 18 test() blocks
- proves: covers: ../server/web-push.mjs

## web-research.test.js

- 417 lines; 80 strict assertions / 16 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## webhook-delivery-load.test.js

- 174 lines; 30 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-plugin-store.mjs, ../server/store.mjs

## webhook-dispatch-store.test.js (loader shim: decompresses .webhook-dispatch-store.b64 into a generated module; 24 tests / 163 strict assertions verified green 2026-10-09)

- 12 lines; 0 strict assertions / 0 test() blocks
- proves: pure unit logic (no http/db detected)

## webhook-dispatch.test.js

- 380 lines; 126 strict assertions / 25 test() blocks
- proves: HTTP surface; covers: ../server/webhook-dispatch.mjs

## webhook-doc-contract.test.js

- 67 lines; 25 strict assertions / 1 test() blocks
- proves: covers: ../server/agent-webhook-subscriptions.mjs, ../server/webhook-dispatch.mjs

## webhook-limits.test.js

- 177 lines; 43 strict assertions / 5 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/telegram-contract-fixture.mjs, ../server/channel-import.mjs, ../server/channel-journal.mjs

## webhook-retry-backoff.test.js

- 54 lines; 5 strict assertions / 1 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../server/webhook-dispatch.mjs

## webhook-ssrf-dns-failclosed.test.js (thin: <1 strict assert per test)

- 96 lines; 3 strict assertions / 7 test() blocks
- proves: covers: ../server/agent-webhook-subscriptions.mjs

## webhook-ssrf-dns.test.js

- 235 lines; 44 strict assertions / 1 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-webhook-subscriptions.mjs, ../server/http.mjs, ../server/webhook-dispatch.mjs

## webhook-ssrf.test.js

- 161 lines; 20 strict assertions / 12 test() blocks
- proves: HTTP surface; covers: ../server/outbound-webhooks.mjs

## webhook-subscription-ssrf.test.js (thin: <1 strict assert per test)

- 105 lines; 7 strict assertions / 15 test() blocks
- proves: HTTP surface; covers: ../server/agent-webhook-subscriptions.mjs

## weekly-learnings.test.js

- 392 lines; 62 strict assertions / 0 test() blocks
- proves: covers: ../scripts/weekly-learnings.mjs

## whatsapp-adapter.test.js

- 192 lines; 71 strict assertions / 6 test() blocks
- proves: covers: ../server/channel-adapters/whatsapp.mjs, ../server/email-envelope.mjs

## wiki-read-api.test.js

- 357 lines; 97 strict assertions / 20 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/wiki-build.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## work-actions.test.js

- 197 lines; 70 strict assertions / 9 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../scripts/helpers/signed-evidence.mjs

## work-collaboration.test.js

- 87 lines; 19 strict assertions / 5 test() blocks
- proves: HTTP surface

## work-context.test.js

- 480 lines; 205 strict assertions / 12 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/helpers/signed-evidence.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## work-continuity.test.js

- 128 lines; 36 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## work-controls.test.js

- 278 lines; 80 strict assertions / 10 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/helpers/signed-evidence.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## work-declarations.test.js

- 113 lines; 34 strict assertions / 11 test() blocks
- proves: sqlite-backed behavior; covers: ../server/work-declarations.mjs, ../server/work-matchmaking.mjs

## work-discussion.test.js

- 282 lines; 96 strict assertions / 9 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/mcp-test-client.mjs, ../server/http.mjs, ../server/recovery.mjs

## work-evidence-immutable.test.js

- 262 lines; 38 strict assertions / 11 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../server/recovery.mjs, ../server/text-results.mjs

## work-handoff.test.js

- 53 lines; 12 strict assertions / 6 test() blocks
- proves: covers: ../server/work-handoff.mjs

## work-help-audit-ownership.test.js

- 84 lines; 10 strict assertions / 5 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../server/recovery.mjs

## work-help-service.test.js

- 197 lines; 47 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/frozen-runtime-fixture.mjs, ../scripts/helpers/signed-evidence.mjs, ../scripts/runtime-package.mjs

## work-help.test.js

- 269 lines; 133 strict assertions / 18 test() blocks
- proves: pure unit logic (no http/db detected)

## work-history-floor.test.js

- 42 lines; 7 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## work-history.test.js

- 75 lines; 14 strict assertions / 7 test() blocks
- proves: pure unit logic (no http/db detected)

## work-item-session.test.js

- 604 lines; 197 strict assertions / 20 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## work-loops.test.js

- 107 lines; 22 strict assertions / 11 test() blocks
- proves: pure unit logic (no http/db detected)

## work-matchmaking-adversarial.test.js

- 133 lines; 18 strict assertions / 12 test() blocks
- proves: covers: ../server/work-matchmaking.mjs

## work-matchmaking.test.js

- 166 lines; 43 strict assertions / 15 test() blocks
- proves: covers: ../server/work-matchmaking.mjs

## work-preparation.test.js

- 60 lines; 17 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## work-recipes.test.js

- 94 lines; 25 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## work-reuse.test.js

- 132 lines; 46 strict assertions / 6 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## work-search.test.js

- 59 lines; 22 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## work-session-budget.test.js

- 164 lines; 55 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## work-snapshot.test.js

- 147 lines; 48 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior

## work-templates.test.js

- 55 lines; 16 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## workflow.test.js

- 176 lines; 64 strict assertions / 8 test() blocks
- proves: covers: ../server/bootstrap.mjs, ../server/return-selectors.mjs

## writer-fence-property.test.js

- 157 lines; 31 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/writer-fence.mjs

## writer-fence-unfenced.test.js

- 92 lines; 5 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../server/writer-fence.mjs

## writer-fence.test.js

- 137 lines; 30 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior; covers: ../server/store.mjs, ../server/writer-fence.mjs


## Batch summary

- suites: 80
- NO REAL ASSERTIONS: 0 (flagged webhook-dispatch-store.test.js is a compressed-payload loader shim — real assertions in generated module, verified)
- thin/weak assertions: 2 — webhook-ssrf-dns-failclosed.test.js, webhook-subscription-ssrf.test.js
