# Guild-09 docs batch 1

89 suites. For each: what it proves, assertion density, coverage surface.

## a2a-card-truth.test.js

- 161 lines; 17 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/a2a-jsonrpc.mjs, ../server/http.mjs, ../server/store.mjs

## a2a-jsonrpc.test.js

- 60 lines; 21 strict assertions / 4 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/a2a-jsonrpc.mjs, ../server/http.mjs, ../server/store.mjs

## abuse-rate-buckets.test.js

- 80 lines; 17 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/abuse-rate-buckets.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## acceptance-fixture.test.js

- 24 lines; 10 strict assertions / 1 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs

## access-request-cancel.test.js

- 151 lines; 30 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/identity-ratelimit.mjs

## access-request-limits.test.js

- 110 lines; 15 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs, ../server/store.mjs

## access-request-status-next.test.js

- 83 lines; 18 strict assertions / 1 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/identity-ratelimit.mjs

## access-request-status-rate.test.js

- 24 lines; 2 strict assertions / 1 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## access-request-upgrade.test.mjs

- 273 lines; 68 strict assertions / 12 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/identity-ratelimit.mjs

## access-requests-admin-gates.test.js (thin: <1 strict assert per test)

- 77 lines; 2 strict assertions / 3 test() blocks
- proves: sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs, ../server/store.mjs

## access-requests.test.js

- 553 lines; 119 strict assertions / 29 test() blocks
- proves: sqlite-backed behavior; covers: ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/identity-ratelimit.mjs, ../server/store.mjs

## access-review.test.js

- 338 lines; 128 strict assertions / 8 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/access-review.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## account-client.test.js

- 344 lines; 100 strict assertions / 15 test() blocks
- proves: pure unit logic (no http/db detected)

## account-deletion-residual-sec04.test.js

- 87 lines; 14 strict assertions / 3 test() blocks
- proves: covers: ../server/account-deletion.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## account-deletion-residual.test.js

- 155 lines; 21 strict assertions / 7 test() blocks
- proves: sqlite-backed behavior; covers: ../server/account-deletion.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## account-deletion.test.js

- 239 lines; 69 strict assertions / 13 test() blocks
- proves: sqlite-backed behavior

## account-login-methods.test.js

- 395 lines; 108 strict assertions / 24 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/account-login-methods.mjs, ../server/store.mjs

## account-management.test.js

- 240 lines; 71 strict assertions / 8 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## account-passkeys-http.test.js

- 352 lines; 58 strict assertions / 12 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/account-passkeys.mjs, ../server/http.mjs

## account-passkeys.test.js

- 233 lines; 43 strict assertions / 12 test() blocks
- proves: HTTP surface; covers: ../server/account-passkeys.mjs

## account-settings-http.test.js

- 403 lines; 81 strict assertions / 17 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/github-oauth.mjs, ../server/http.mjs

## account-settings-ui.test.js

- 256 lines; 69 strict assertions / 14 test() blocks
- proves: pure unit logic (no http/db detected)

## account-setup-ui.test.js

- 206 lines; 31 strict assertions / 8 test() blocks
- proves: pure unit logic (no http/db detected)

## acquisition-loops.test.js

- 218 lines; 65 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/public-read-model.mjs

## action-classes.test.js

- 55 lines; 18 strict assertions / 4 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../server/action-classes.mjs, ../server/store.mjs

## action-recovery.test.js

- 65 lines; 11 strict assertions / 2 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs, ../scripts/helpers/signed-evidence.mjs

## activity.test.js

- 284 lines; 76 strict assertions / 17 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## admin-guide-doc.test.js

- 26 lines; 5 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## admin-routes-autonomy-tier.test.js

- 82 lines; 10 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## agent-access-requests-http.test.js

- 177 lines; 26 strict assertions / 8 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## agent-autonomy-client.test.js

- 335 lines; 86 strict assertions / 8 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/outside-agents.mjs

## agent-browser-signin.test.js

- 202 lines; 23 strict assertions / 10 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## agent-capabilities-http.test.js

- 92 lines; 14 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## agent-card-deploy-consistency.test.js

- 267 lines; 38 strict assertions / 16 test() blocks
- proves: covers: ../scripts/prod-deploy-smoke.mjs, ../server/agent-card-signing.mjs

## agent-card-signing.test.js

- 385 lines; 73 strict assertions / 24 test() blocks
- proves: covers: ../server/agent-card-signing.mjs, ../server/agent-directory.mjs

## agent-card-wellknown.test.js

- 264 lines; 96 strict assertions / 16 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-card-signing.mjs, ../server/http.mjs, ../server/store.mjs

## agent-connect-page.test.js

- 238 lines; 66 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/routes/agent-connect.mjs, ../server/store.mjs

## agent-connection.test.js

- 213 lines; 75 strict assertions / 8 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## agent-connections-identityid.test.js

- 83 lines; 23 strict assertions / 5 test() blocks
- proves: covers: ../server/bootstrap.mjs, ../server/store.mjs

## agent-directory-a2a.test.mjs

- 144 lines; 37 strict assertions / 7 test() blocks
- proves: covers: ../server/agent-card-signing.mjs, ../server/agent-directory.mjs

## agent-directory-owns-reach.test.mjs

- 144 lines; 30 strict assertions / 7 test() blocks
- proves: covers: ../server/agent-card-signing.mjs, ../server/agent-directory.mjs

## agent-discovery-transport.test.js

- 36 lines; 13 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## agent-discovery.test.js

- 635 lines; 338 strict assertions / 22 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/http.mjs, ../server/store.mjs

## agent-doctor.test.js

- 293 lines; 82 strict assertions / 18 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/agent-doctor.mjs, ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## agent-enrollment-atomic.test.js

- 232 lines; 49 strict assertions / 17 test() blocks
- proves: covers: ../server/bootstrap.mjs, ../server/store.mjs

## agent-enrollment.test.js

- 200 lines; 78 strict assertions / 12 test() blocks
- proves: covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/recovery.mjs, ../server/store.mjs

## agent-error-dm-and-types.test.js

- 45 lines; 16 strict assertions / 3 test() blocks
- proves: covers: ../server/store.mjs

## agent-error-hints.test.js

- 87 lines; 7 strict assertions / 5 test() blocks
- proves: pure unit logic (no http/db detected)

## agent-error-next.test.js

- 371 lines; 117 strict assertions / 6 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## agent-first-run-fallback.test.js

- 79 lines; 8 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## agent-fleet.test.js

- 175 lines; 45 strict assertions / 6 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-fleet.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## agent-guide-doc.test.js

- 34 lines; 5 strict assertions / 2 test() blocks
- proves: pure unit logic (no http/db detected)

## agent-handoff.test.js

- 122 lines; 22 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/helpers/signed-evidence.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## agent-heartbeats.test.js

- 507 lines; 142 strict assertions / 15 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../scripts/helpers/signed-evidence.mjs, ../server/agent-card-signing.mjs, ../server/agent-heartbeats.mjs

## agent-identities-deceptive-name.test.js

- 63 lines; 4 strict assertions / 4 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## agent-identities-recoverable-credential.test.js

- 47 lines; 6 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/store.mjs

## agent-identities.test.js

- 812 lines; 229 strict assertions / 25 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-identities.mjs, ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## agent-identity-secrets.test.js

- 266 lines; 56 strict assertions / 10 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## agent-inbox-keys.test.js

- 172 lines; 37 strict assertions / 5 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## agent-inbox.test.js

- 171 lines; 42 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## agent-invite-ui.test.js

- 85 lines; 29 strict assertions / 8 test() blocks
- proves: HTTP surface

## agent-invites-mail-unconfigured.test.js

- 120 lines; 11 strict assertions / 2 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## agent-invites.test.js

- 707 lines; 248 strict assertions / 31 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/bootstrap.mjs, ../server/http.mjs, ../server/store.mjs

## agent-key-registry.test.js

- 136 lines; 23 strict assertions / 2 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-card-signing.mjs, ../server/http.mjs, ../server/store.mjs

## agent-lanes.test.js

- 160 lines; 42 strict assertions / 16 test() blocks
- proves: covers: ../server/agent-lanes.mjs, ../server/work-matchmaking.mjs

## agent-mentions-inbox.test.js

- 257 lines; 74 strict assertions / 11 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/mcp-test-client.mjs, ../server/autonomy-tiers.mjs, ../server/http.mjs

## agent-onboarding-drift.test.mjs

- 71 lines; 11 strict assertions / 3 test() blocks
- proves: pure unit logic (no http/db detected)

## agent-onboarding.test.js

- 283 lines; 66 strict assertions / 22 test() blocks
- proves: covers: ../scripts/agent-onboard.mjs

## agent-plugin-api-keys.test.js

- 113 lines; 43 strict assertions / 7 test() blocks
- proves: covers: ../server/agent-api-keys.mjs

## agent-plugin-directory.test.js

- 233 lines; 58 strict assertions / 12 test() blocks
- proves: covers: ../server/agent-card-signing.mjs, ../server/agent-directory.mjs

## agent-plugin-http.test.js

- 708 lines; 194 strict assertions / 19 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-card-signing.mjs, ../server/agent-plugin-manifest.mjs, ../server/agent-webhook-subscriptions.mjs

## agent-plugin-loop.test.js

- 104 lines; 19 strict assertions / 1 test() blocks
- proves: covers: ../server/agent-api-keys.mjs, ../server/agent-card-signing.mjs, ../server/agent-directory.mjs, ../server/agent-plugin-manifest.mjs

## agent-plugin-manifest.test.js

- 82 lines; 36 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../server/agent-plugin-manifest.mjs

## agent-plugin-sentinel-secrets.test.js

- 123 lines; 18 strict assertions / 7 test() blocks
- proves: covers: ../server/agent-webhook-subscriptions.mjs

## agent-plugin-webhook-subs.test.js

- 123 lines; 49 strict assertions / 6 test() blocks
- proves: covers: ../server/agent-webhook-subscriptions.mjs

## agent-presence-http.test.js

- 162 lines; 30 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/http.mjs

## agent-resume.test.js

- 314 lines; 114 strict assertions / 15 test() blocks
- proves: HTTP surface

## agent-safety-q3d.test.js

- 142 lines; 38 strict assertions / 4 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-webhook-subscriptions.mjs, ../server/autonomy-tiers.mjs, ../server/content-trust.mjs

## agent-scope-handoff.test.js

- 143 lines; 58 strict assertions / 1 test() blocks
- proves: pure unit logic (no http/db detected)

## agent-self-onboarding.test.js

- 109 lines; 21 strict assertions / 3 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../server/agent-identities.mjs, ../server/http.mjs, ../server/store.mjs

## agent-setup.test.js

- 288 lines; 98 strict assertions / 17 test() blocks
- proves: HTTP surface; covers: ../scripts/mcp-test-client.mjs, ../server/access-requests.mjs, ../server/bootstrap.mjs, ../server/http.mjs

## agent-signin-autocomplete.test.js

- 85 lines; 7 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## agent-signin-onboarding.test.js

- 165 lines; 26 strict assertions / 5 test() blocks
- proves: sqlite-backed behavior; covers: ../server/autonomy-tiers.mjs, ../server/bootstrap.mjs, ../server/store.mjs

## agent-signin-ui.test.js

- 78 lines; 10 strict assertions / 4 test() blocks
- proves: pure unit logic (no http/db detected)

## agent-type-catalog.test.js

- 131 lines; 58 strict assertions / 5 test() blocks
- proves: covers: ../scripts/acceptance-fixture.mjs

## agent-upgrade.test.js

- 250 lines; 60 strict assertions / 2 test() blocks
- proves: sqlite-backed behavior; covers: ../scripts/frozen-runtime-fixture.mjs, ../scripts/runtime-package.mjs, ../server/agent-connections.mjs, ../server/recovery.mjs

## agent-wake-poll.test.js

- 458 lines; 88 strict assertions / 16 test() blocks
- proves: HTTP surface; sqlite-backed behavior; covers: ../scripts/acceptance-fixture.mjs, ../server/agent-heartbeats.mjs, ../server/agent-rooms.mjs, ../server/http.mjs

## agent-wake.test.js

- 153 lines; 45 strict assertions / 7 test() blocks
- proves: HTTP surface; sqlite-backed behavior

## agent-work-preflight.test.js

- 79 lines; 18 strict assertions / 3 test() blocks
- proves: HTTP surface; covers: ../scripts/acceptance-fixture.mjs, ../scripts/agent-work-preflight.mjs, ../server/http.mjs, ../server/recovery.mjs


## Batch summary

- suites: 89
- NO REAL ASSERTIONS: 0
- thin/weak assertions: 1 — access-requests-admin-gates.test.js
