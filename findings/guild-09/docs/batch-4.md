# Guild-09 docs batch 4

89 suites. For each: what it proves, assertion density, coverage surface.

## docs-tool-list.test.js

- 106 lines; 10 strict assertions / 5 test() blocks
- proves: covers: ../server/mcp-discovery.mjs

## docs-troubleshooting.test.js

- 122 lines; 26 strict assertions / 4 test() blocks
- proves: HTTP surface

## dogfood-agent-surface.test.js

- 365 lines; 62 strict assertions / 14 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-card-signing.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## done-chip-motion.test.js

- 46 lines; 9 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## done-chip.test.js

- 18 lines; 6 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## door-links-join.test.js

- 36 lines; 4 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## door-links-loop.test.js

- 88 lines; 9 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## draft-feedback.test.js

- 64 lines; 21 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## draft-return.test.js

- 47 lines; 14 strict assertions / 2 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs

## draft-session-expiry.test.js

- 83 lines; 10 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## durable-object-rpc.test.js

- 282 lines; 24 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../server/email-routing-inbound.mjs

## edge-stall.test.js

- 56 lines; 29 strict assertions / 3 test() blocks
- proves: covers: ../scripts/stall-probe.mjs

## email-contract.test.js

- 215 lines; 80 strict assertions / 20 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../server/email-envelope.mjs, ../server/graph-email.mjs

## email-envelope-property.test.js

- 243 lines; 43 strict assertions / 8 test() blocks
- proves: covers: ../scripts/email-contract-fixture.mjs, ../server/email-envelope.mjs, ../server/graph-email.mjs

## email-import.test.js

- 356 lines; 143 strict assertions / 25 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/candidate-runtime-fixture.mjs, ../scripts/compare-recovery.mjs, ../scripts/email-contract-fixture.mjs

## email-routing-inbound.test.js

- 194 lines; 127 strict assertions / 8 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/channel-adapters/email.mjs, ../server/channel-adapters/index.mjs, ../server/channel-import.mjs

## email-verify-migration-backfill.test.js

- 121 lines; 11 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/account-login-methods.mjs

## emoji-catalog.test.js

- 55 lines; 13 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## emoji.test.js

- 135 lines; 55 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## entry-docs-start-here.test.mjs

- 113 lines; 14 strict assertions / 7 test() blocks
- proves: pure unit logic (no http/db detected)

## error-leak-shapes.test.js

- 106 lines; 15 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior

## error-shapes-availability.test.js

- 183 lines; 54 strict assertions / 12 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## error-shapes-teach.test.js

- 186 lines; 53 strict assertions / 11 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## evals-harness.test.js

- 166 lines; 34 strict assertions / 11 test() blocks
- proves: pure unit logic (no http/db detected)

## evals-heldout.test.js

- 109 lines; 20 strict assertions / 9 test() blocks
- proves: pure unit logic (no http/db detected)

## evals-llm-judge-compat.test.js

- 117 lines; 22 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## evals-llm-judge.test.js

- 146 lines; 19 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## evals-splits.test.js

- 95 lines; 19 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## event-audit.test.js

- 86 lines; 10 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## events-after-sequence.test.js

- 79 lines; 19 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## events-cursor-paging.test.js

- 142 lines; 20 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## events.test.js

- 671 lines; 142 strict assertions / 37 test() blocks
- proves: pure unit logic (no http/db detected)

## external-probe.test.js

- 358 lines; 81 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## external-producer.test.js

- 144 lines; 41 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/mcp-test-client.mjs, ../scripts/runtime-package.mjs, ../server/http.mjs

## f12-board-mcp.test.js

- 302 lines; 101 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs, ../server/store.mjs

## fake-runner.test.js

- 73 lines; 9 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/fake-runner.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## faq-doc.test.js

- 88 lines; 12 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## feedback-routes.test.js

- 338 lines; 75 strict assertions / 23 test() blocks
- proves: covers: ../server/feedback-routes.mjs, ../server/feedback-store.mjs

## feedback-scrub.test.js

- 110 lines; 31 strict assertions / 10 test() blocks
- proves: covers: ../server/feedback-scrub.mjs

## feedback-store.test.js

- 373 lines; 63 strict assertions / 28 test() blocks
- proves: covers: ../server/feedback-store.mjs

## first-paint.test.js

- 52 lines; 7 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## flaky-detect.test.js

- 107 lines; 18 strict assertions / 9 test() blocks
- proves: pure unit logic (no http/db detected)

## focused-orientation.test.js

- 143 lines; 48 strict assertions / 5 test() blocks
- proves: HTTP surface

## friction-work.test.js

- 79 lines; 7 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/notifications.mjs, ../server/store.mjs

## friend-bond-ui.test.js

- 162 lines; 52 strict assertions / 13 test() blocks
- proves: pure unit logic (no http/db detected)

## fulltext-search.test.js

- 257 lines; 57 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## github-app-core.test.js

- 335 lines; 84 strict assertions / 11 test() blocks
- proves: covers: ../server/github-app/auth.mjs, ../server/github-app/index.mjs, ../server/github-app/policy.mjs, ../server/github-app/render.mjs

## github-door.test.js

- 216 lines; 63 strict assertions / 10 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/github-door.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## github-oauth-http.test.js

- 357 lines; 81 strict assertions / 17 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/github-oauth.mjs, ../server/http.mjs

## github-oauth.test.js

- 217 lines; 53 strict assertions / 16 test() blocks
- proves: covers: ../server/github-oauth.mjs

## github-unconfigured-sweep.test.js

- 56 lines; 7 strict assertions / 4 test() blocks
- proves: covers: ../server/claim-autolink.mjs, ../server/claim-pr-sync.mjs, ../server/github-app/auth.mjs, ../server/store.mjs

## github-work-sync.test.js

- 60 lines; 11 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/github-work-sync.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## gmail-actions.test.js

- 93 lines; 45 strict assertions / 8 test() blocks
- proves: HTTP surface

## gmail-adapter.test.js

- 147 lines; 76 strict assertions / 5 test() blocks
- proves: covers: ../scripts/gmail-contract-fixture.mjs, ../server/channel-adapters/gmail.mjs, ../server/channel-adapters/index.mjs, ../server/email-envelope.mjs

## gmail-live-fixture.test.js

- 47 lines; 7 strict assertions / 3 test() blocks
- proves: covers: ../scripts/gmail-live-fixture.mjs

## gmail-mailbox.test.js

- 147 lines; 48 strict assertions / 12 test() blocks
- proves: HTTP surface

## gmail-sync.test.js

- 92 lines; 32 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## gmail-ui.test.js

- 39 lines; 9 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## google-oauth-email.test.js

- 175 lines; 27 strict assertions / 8 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/google-oauth.mjs, ../server/http.mjs

## google-oauth-http.test.js

- 291 lines; 63 strict assertions / 17 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/helpers/google-oauth-fixture.mjs, ../server/google-oauth.mjs, ../server/http.mjs

## grants.test.js

- 276 lines; 60 strict assertions / 15 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/grants.mjs, ../server/http.mjs

## graph-fixture-sync.test.js

- 184 lines; 44 strict assertions / 10 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/candidate-runtime-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../scripts/runtime-package.mjs

## graph-reply-draft.test.js

- 135 lines; 44 strict assertions / 9 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/candidate-runtime-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../scripts/runtime-package.mjs

## graph-reply-journal.test.js

- 459 lines; 130 strict assertions / 22 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/email-contract-fixture.mjs, ../scripts/frozen-runtime-fixture.mjs, ../scripts/runtime-package.mjs

## graph-reply-update-journal.test.js

- 606 lines; 205 strict assertions / 29 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/candidate-runtime-fixture.mjs, ../scripts/frozen-runtime-fixture.mjs, ../scripts/reply-update-fixture.mjs, ../scripts/runtime-package.mjs

## graph-reply-update.test.js

- 210 lines; 68 strict assertions / 14 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/candidate-runtime-fixture.mjs, ../scripts/reply-update-fixture.mjs, ../scripts/runtime-package.mjs, ../server/email-envelope.mjs

## grok-host.test.js

- 962 lines; 225 strict assertions / 52 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/grok-room-host.mjs, ../server/agent-rooms.mjs, ../server/http.mjs, ../server/store.mjs

## growth-alerts.test.js

- 200 lines; 49 strict assertions / 11 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-collector.test.js

- 166 lines; 70 strict assertions / 12 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-compare.test.js

- 184 lines; 60 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-digest.test.js

- 139 lines; 44 strict assertions / 11 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-emit.test.js

- 223 lines; 57 strict assertions / 15 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-events.test.js

- 105 lines; 38 strict assertions / 11 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-experiments.test.js

- 52 lines; 13 strict assertions / 4 test() blocks
- proves: covers: ../server/growth-experiments.mjs

## growth-fanout.test.js

- 194 lines; 47 strict assertions / 12 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-http.test.js

- 204 lines; 53 strict assertions / 13 test() blocks
- proves: HTTP surface

## growth-loop.test.js

- 213 lines; 49 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/bootstrap.mjs, ../server/growth-loop.mjs, ../server/http.mjs

## growth-mentions.test.js

- 141 lines; 39 strict assertions / 13 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-persistence.test.js

- 148 lines; 42 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-scheduler.test.js

- 211 lines; 44 strict assertions / 12 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-summary.test.js

- 153 lines; 46 strict assertions / 10 test() blocks
- proves: pure unit logic (no http/db detected)

## growth-watch.test.js

- 194 lines; 55 strict assertions / 10 test() blocks
- proves: pure unit logic (no http/db detected)

## guest-agent-link-credential-boundary.test.js

- 56 lines; 12 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/guest-agent-links.mjs, ../server/store.mjs

## guest-agent-links.test.js

- 282 lines; 97 strict assertions / 9 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/guest-agent-links.mjs, ../server/http.mjs

## guest-agent-refresh.test.mjs

- 226 lines; 42 strict assertions / 9 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/guest-agent-links.mjs, ../server/http.mjs

## guest-bearer-origin.test.js

- 219 lines; 39 strict assertions / 8 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## guest-invite-expiry-docs.test.mjs

- 161 lines; 60 strict assertions / 10 test() blocks
- proves: HTTP surface

## guest-invite-flow.test.js

- 679 lines; 169 strict assertions / 21 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/guest-invites.mjs, ../server/http.mjs

## guest-invites-agent-api-docs.test.mjs

- 81 lines; 6 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)


## Batch summary

- suites: 89
- NO REAL ASSERTIONS: 0
- thin/weak assertions: 0
