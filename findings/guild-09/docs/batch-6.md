# Guild-09 docs batch 6

89 suites. For each: what it proves, assertion density, coverage surface.

## invitation-evidence.test.js

- 61 lines; 10 strict assertions / 4 test() blocks
- proves: covers: ../server/invitation-evidence.mjs

## invitation-http.test.js

- 387 lines; 93 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## invitation-journal.test.js

- 192 lines; 51 strict assertions / 9 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/invitation-journal.mjs, ../server/store.mjs

## invitation-migration-v36.test.js

- 181 lines; 16 strict assertions / 1 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs, ../server/store.mjs

## invitation-note.test.js

- 124 lines; 15 strict assertions / 4 test() blocks
- proves: HTTP surface

## invitation-owner-admin.test.js

- 146 lines; 17 strict assertions / 8 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs, ../server/store.mjs

## invitation-stats.test.js

- 104 lines; 12 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## invitations.test.js

- 481 lines; 111 strict assertions / 14 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## invite-flow-abuse.test.js

- 154 lines; 16 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## invite-oauth-context.test.js

- 241 lines; 50 strict assertions / 19 test() blocks
- proves: pure unit logic (no http/db detected)

## invite-only-boundary.test.js

- 329 lines; 27 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/open-routes.mjs, ../scripts/route-docs-check.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## invite-redeem-422.test.js

- 66 lines; 8 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## jev-admission.test.js

- 126 lines; 31 strict assertions / 12 test() blocks
- proves: covers: ../server/jev-admission.mjs

## jev-receipts.test.js

- 136 lines; 29 strict assertions / 11 test() blocks
- proves: covers: ../server/jev-receipts.mjs

## jev-shadow-http.test.js

- 148 lines; 41 strict assertions / 6 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## jev-shadow-journal.test.js

- 105 lines; 25 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../server/store.mjs

## jev-shadow-store.test.js

- 54 lines; 8 strict assertions / 2 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs

## job-heartbeat.test.js

- 324 lines; 82 strict assertions / 12 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## jobs-node-retry.test.js

- 102 lines; 15 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/jobs.mjs, ../server/store.mjs

## jobs-parity.test.js

- 31 lines; 9 strict assertions / 1 test() blocks
- proves: covers: ../server/jobs.mjs

## join-any-agent.test.js

- 50 lines; 18 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## join-handoff.test.js

- 38 lines; 9 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## join-onboarding-docs.test.js

- 78 lines; 6 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## join-p2s.test.js

- 231 lines; 51 strict assertions / 10 test() blocks
- proves: sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs, ../server/notifications.mjs

## join-page.test.js

- 285 lines; 78 strict assertions / 10 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## join-session-1522.test.js

- 74 lines; 7 strict assertions / 4 test() blocks
- proves: covers: ../server/bootstrap.mjs, ../server/store.mjs

## join-vocabulary.test.js

- 224 lines; 28 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## join.test.js

- 103 lines; 52 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## journey-coverage.test.js

- 64 lines; 15 strict assertions / 5 test() blocks
- proves: covers: ../scripts/journey-coverage.mjs

## kb-index.test.js

- 69 lines; 4 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## land-card-model.test.js

- 66 lines; 16 strict assertions / 6 test() blocks
- proves: pure unit logic (no http/db detected)

## land-queue.test.js

- 781 lines; 217 strict assertions / 21 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/land-queue.mjs

## landing-facts.test.js

- 226 lines; 37 strict assertions / 10 test() blocks
- proves: covers: ../scripts/landing-facts.mjs

## landing-hero.test.mjs

- 41 lines; 6 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## lease-renewal.test.js

- 318 lines; 51 strict assertions / 22 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/work-claim-routes.mjs, ../server/work-claims.mjs

## legal-pages.test.js

- 296 lines; 73 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/legal-documents.mjs, ../server/legal-store.mjs

## legal-templates-grounding.test.js

- 244 lines; 5 strict assertions / 4 test() blocks
- proves: HTTP surface

## lesson-contradictions.test.js

- 194 lines; 29 strict assertions / 0 test() blocks
- proves: covers: ../scripts/lesson-contradictions.mjs

## lesson-scorer.test.js

- 239 lines; 32 strict assertions / 0 test() blocks
- proves: covers: ../scripts/lesson-scorer.mjs

## listing-check.test.js

- 211 lines; 50 strict assertions / 7 test() blocks
- proves: covers: ../scripts/listing-check.mjs

## live-audit.test.js

- 62 lines; 7 strict assertions / 4 test() blocks
- proves: HTTP surface

## live-smoke.test.js

- 111 lines; 11 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../scripts/live-smoke.mjs

## llms-accuracy.test.js

- 175 lines; 18 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/http.mjs, ../server/store.mjs

## load-test-10x.test.js

- 359 lines; 52 strict assertions / 10 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## load-test-smoke.test.js

- 55 lines; 27 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## lookup-indexes.test.js

- 132 lines; 4 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/store.mjs

## low-batch-1529.test.js

- 90 lines; 15 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## machine-bot-halt.test.js

- 77 lines; 9 strict assertions / 4 test() blocks
- proves: covers: ../machine/bot/loop.mjs

## machine-control-during-call.test.js

- 117 lines; 13 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../machine/lib/config.mjs, ../machine/lib/daemon.mjs, ../machine/lib/spawn.mjs, ../machine/test/fake-relay.mjs

## machine-pause-duration.test.js

- 32 lines; 9 strict assertions / 2 test() blocks
- proves: covers: ../machine/lib/daemon.mjs, ../machine/lib/protocol.mjs

## machine-pause-restart.test.js

- 50 lines; 8 strict assertions / 3 test() blocks
- proves: covers: ../machine/lib/config.mjs, ../machine/lib/daemon.mjs

## magic-account-switch.test.js

- 133 lines; 17 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs, ../server/magic-links.mjs

## magic-code-consume-race.test.js

- 65 lines; 4 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/store.mjs

## magic-invalidation.test.js

- 64 lines; 11 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/store.mjs

## magic-links-http.test.js

- 228 lines; 56 strict assertions / 10 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs, ../server/magic-links.mjs

## magic-links.test.js

- 83 lines; 21 strict assertions / 6 test() blocks
- proves: sqlite-backed behavior; covers: ../server/magic-links.mjs, ../server/store.mjs

## maintenance-signals.test.js

- 46 lines; 13 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior

## maintenance.test.js

- 75 lines; 28 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/maintenance.mjs

## matchmaking-routes.test.js

- 127 lines; 25 strict assertions / 9 test() blocks
- proves: covers: ../server/agent-lanes.mjs, ../server/matchmaking-routes.mjs

## mcp-500-error-trace.test.js

- 85 lines; 18 strict assertions / 8 test() blocks
- proves: HTTP surface

## mcp-bounty-escrow-errors.test.js

- 109 lines; 15 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs

## mcp-calltime-denials.test.js

- 299 lines; 33 strict assertions / 10 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs

## mcp-core-profile.test.js

- 482 lines; 145 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-api-keys.mjs, ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## mcp-discovery-aliases.test.js

- 87 lines; 16 strict assertions / 6 test() blocks
- proves: covers: ../server/mcp-discovery.mjs

## mcp-docs-accuracy.test.js

- 113 lines; 18 strict assertions / 7 test() blocks
- proves: HTTP surface; covers: ../scripts/room-mcp-init.mjs

## mcp-dotted-aliases.test.js

- 215 lines; 42 strict assertions / 6 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/http.mjs, ../server/mcp-hosted-tools.mjs, ../server/mcp-http.mjs

## mcp-empty-bearer.test.js

- 40 lines; 8 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../server/mcp-http.mjs

## mcp-identity-mint.test.js

- 137 lines; 27 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## mcp-integration.test.js

- 62 lines; 31 strict assertions / 1 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/mcp-test-client.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## mcp-land-queue-autonomy-tier.test.js

- 78 lines; 7 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs

## mcp-lifecycle.test.js

- 239 lines; 78 strict assertions / 7 test() blocks
- proves: covers: ../scripts/helpers/signed-evidence.mjs, ../scripts/mcp-test-client.mjs, ../scripts/work-lifecycle-agent-fixture.mjs, ../server/autonomy-tiers.mjs

## mcp-openapi-drift.test.js

- 403 lines; 7 strict assertions / 4 test() blocks
- proves: covers: ../server/mcp-hosted-tools.mjs, ../server/mcp-public-work.mjs

## mcp-registry-publish.test.js

- 178 lines; 13 strict assertions / 13 test() blocks
- proves: pure unit logic (no http/db detected)

## mcp-registry-server-json.test.js

- 58 lines; 15 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## mcp-server-card.test.js

- 136 lines; 44 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/http.mjs, ../server/store.mjs

## mcp-stdio.test.js

- 388 lines; 118 strict assertions / 18 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## mcp-tools-reconciliation.test.js

- 101 lines; 13 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../server/mcp-discovery.mjs, ../server/mcp-hosted-tools.mjs, ../server/mcp-http.mjs, ../server/mcp-identity-mint.mjs

## mcp-untrusted-content.test.js

- 184 lines; 41 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-rooms.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs, ../server/store.mjs

## mcp-version-negotiation.test.js

- 77 lines; 14 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## mcp-work-context.test.js

- 48 lines; 15 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/mcp-test-client.mjs, ../server/agent-rooms.mjs, ../server/http.mjs, ../server/store.mjs

## measure-cold-start.test.js

- 60 lines; 22 strict assertions / 3 test() blocks
- proves: HTTP surface

## member-cap-active-invariant.test.js

- 100 lines; 13 strict assertions / 4 test() blocks
- proves: covers: ../server/bootstrap.mjs, ../server/store.mjs, ../server/usage-summary.mjs

## member-deactivate.test.js

- 100 lines; 16 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## member-display-names.test.js

- 31 lines; 6 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## member-permission-requests.test.js

- 210 lines; 62 strict assertions / 9 test() blocks
- proves: HTTP surface; covers: ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/member-permission-requests.mjs

## member-status.test.js

- 103 lines; 15 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## members-directory.test.js

- 152 lines; 25 strict assertions / 5 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## membership-delegation.test.js

- 458 lines; 82 strict assertions / 29 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## mention-lifecycle.test.js

- 428 lines; 124 strict assertions / 22 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/inbox-agent-routing.mjs, ../server/mention-lifecycle.mjs


## Batch summary

- suites: 89
- NO REAL ASSERTIONS: 0
- thin/weak assertions: 0
