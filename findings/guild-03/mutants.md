
## mutation run 2026-10-09 07:14 UTC
- `M1:a` server/feedback-routes.mjs [flipped-guest-check] → **KILLED** — 6.4s; failing: tests/feedback-routes.test.js
- `M1:b` server/feedback-routes.mjs [flipped-lane-mismatch] → **KILLED** — 7.2s; failing: tests/feedback-routes.test.js
- `M1:c` server/feedback-routes.mjs [off-by-one-limiter] → **KILLED** — 7.8s; failing: tests/feedback-routes.test.js
- `M1:d` server/feedback-routes.mjs [dropped-head-guard] → **KILLED** — 4.5s; failing: tests/feedback-routes.test.js
- `M2:a` server/mcp-http.mjs [flipped-auth-status] → **KILLED** — 35.3s; failing: tests/mcp-empty-bearer.test.js
- `M2:b` server/mcp-http.mjs [bearer-case-sensitive] → **SURVIVED** — 26.5s; all 2 test file(s) pass
- `M2:c` server/mcp-http.mjs [off-by-one-id-length] → **SURVIVED** — 26.1s; all 2 test file(s) pass
- `M2:d` server/mcp-http.mjs [swapped-version-negotiation] → **SURVIVED** — 38.4s; all 2 test file(s) pass
- `M3:a` server/mcp-arg-errors.mjs [off-by-one-near-miss] → **KILLED** — 7.5s; failing: tests/qa5-agent-errors.test.js
- `M3:b` server/mcp-arg-errors.mjs [flipped-edit-cost] → **KILLED** — 5.4s; failing: tests/qa5-agent-errors.test.js
- `M3:c` server/mcp-arg-errors.mjs [off-by-one-maxlength] → **SURVIVED** — 7.1s; all 1 test file(s) pass
- `M3:d` server/mcp-arg-errors.mjs [flipped-base64-check] → **SURVIVED** — 10.0s; all 1 test file(s) pass
- `M4:a` server/mcp-discovery.mjs [flipped-outside-check] → **SURVIVED** — 17.3s; all 2 test file(s) pass
- `M4:b` server/mcp-discovery.mjs [dropped-common-focus] → **SURVIVED** — 13.3s; all 2 test file(s) pass
- `M5:a` server/mcp-full-profile.mjs [dropped-roomid-check] → **SURVIVED** — 75.1s; all 2 test file(s) pass
- `M5:b` server/mcp-full-profile.mjs [flipped-guest-carveout] → **KILLED** — 43.9s; failing: tests/mcp-calltime-denials.test.js
- `M5:c` server/mcp-full-profile.mjs [flipped-private-flag] → **SURVIVED** — 63.3s; all 2 test file(s) pass
- `M5:d` server/mcp-full-profile.mjs [flipped-spend-void] → **SURVIVED** — 69.1s; all 2 test file(s) pass
- `M6:a` server/mcp-hosted-tools.mjs [dropped-required-field] → **SURVIVED** — 9.9s; all 1 test file(s) pass
- `M6:b` server/mcp-hosted-tools.mjs [flipped-readonly-hint] → **SURVIVED** — 8.0s; all 1 test file(s) pass
- `M7:a` server/mcp-identity-mint.mjs [dropped-notification-guard] → **SURVIVED** — 38.9s; all 1 test file(s) pass
- `M7:b` server/mcp-identity-mint.mjs [off-by-one-id-length] → **SURVIVED** — 31.7s; all 1 test file(s) pass
- `M8:a` server/mcp-public-work.mjs [flipped-auth-gate] → **KILLED** — 31.3s; failing: tests/public-work-mcp.test.js
- `M8:b` server/mcp-public-work.mjs [off-by-one-id-length] → **SURVIVED** — 32.3s; all 1 test file(s) pass
- `M8:c` server/mcp-public-work.mjs [boundary-lease-zero] → **KILLED** — 28.9s; failing: tests/public-work-mcp.test.js
- `M9:a` server/mcp-room-profile.mjs [bearer-case-sensitive] → **KILLED** — 44.7s; failing: tests/mcp-calltime-denials.test.js
- `M9:b` server/mcp-room-profile.mjs [off-by-one-signal-cap] → **SURVIVED** — 37.6s; all 1 test file(s) pass
- `M9:c` server/mcp-room-profile.mjs [off-by-one-secret-min] → **SURVIVED** — 45.5s; all 1 test file(s) pass
- `M9:d` server/mcp-room-profile.mjs [wrong-escrow-status] → **SURVIVED** — 39.0s; all 1 test file(s) pass
- `M10:a` server/work-claim-routes.mjs [boundary-lease-expiry] → **SURVIVED** — 77.0s; all 3 test file(s) pass
- `M10:b` server/work-claim-routes.mjs [dropped-identity-change-check] → **SKIPPED** — old occurs 2x (need 1)
- `M10:c` server/work-claim-routes.mjs [off-by-one-receipt-limit] → **SURVIVED** — 85.2s; all 3 test file(s) pass
- `M10:d` server/work-claim-routes.mjs [off-by-one-cursor-offset] → **SURVIVED** — 79.0s; all 3 test file(s) pass
- `M11:a` server/bounty-escrow-routes.mjs [flipped-owner-check] → **KILLED** — 5.0s; failing: tests/bounty-escrow-routes.test.js
- `M11:b` server/bounty-escrow-routes.mjs [dropped-sybil-owner-gate] → **SURVIVED** — 6.1s; all 1 test file(s) pass
- `M11:c` server/bounty-escrow-routes.mjs [off-by-one-identity-length] → **SURVIVED** — 3.0s; all 1 test file(s) pass
- `M11:d` server/bounty-escrow-routes.mjs [array-payload-accepted] → **SURVIVED** — 2.7s; all 1 test file(s) pass
- `M12:a` server/matchmaking-routes.mjs [dropped-courier-gate] → **SURVIVED** — 3.0s; all 1 test file(s) pass
- `M12:b` server/matchmaking-routes.mjs [inverted-closed-filter] → **KILLED** — 3.0s; failing: tests/matchmaking-routes.test.js
- `M13:a` server/inbox-collab-routes.mjs [flipped-human-gate] → **KILLED** — 26.2s; failing: tests/inbox-collab-http.test.js
- `M13:b` server/inbox-collab-routes.mjs [flipped-agent-gate] → **KILLED** — 53.1s; failing: tests/inbox-collab-http.test.js
- `M13:c` server/inbox-collab-routes.mjs [flipped-routing-policy-gate] → **KILLED** — 50.6s; failing: tests/inbox-collab-http.test.js
- `M13:d` server/inbox-collab-routes.mjs [head-falls-in-transaction] → **KILLED** — 34.6s; failing: tests/inbox-collab-http.test.js
- `M14:a` server/agent-plugin-routes.mjs [dropped-key-mgmt-gate] → **SURVIVED** — 6.4s; all 2 test file(s) pass
- `M14:b` server/agent-plugin-routes.mjs [wildcard-grants-all] → **SURVIVED** — 5.6s; all 2 test file(s) pass
- `M15:a` server/operator-routes.mjs [dropped-operator-token-check] → **KILLED** — 45.9s; failing: tests/operator-purge.test.js
- `M15b:a` server/legal-routes.mjs [dropped-pow-check] → **SURVIVED** — 26.0s; all 1 test file(s) pass
- `M15c:a` server/supervision-routes.mjs [flipped-confirm-gate] → **KILLED** — 1.4s; failing: tests/supervision-routes.test.js
- `M15c:b` server/supervision-routes.mjs [off-by-one-suggestion-index] → **SURVIVED** — 1.2s; all 1 test file(s) pass
- `M15d:a` server/next-actions-routes.mjs [dropped-auth-gate] → **SURVIVED** — 19.8s; all 1 test file(s) pass

summary: 50 mutants, 19 killed, 30 survived, rest skipped/invalid

## mutation run 2026-10-09 08:19 UTC
- `M10b1:a` server/work-claim-routes.mjs [dropped-identity-change-check(closeWorkClaim)] → **SURVIVED** — 80.8s; all 2 test file(s) pass
- `M10b2:a` server/work-claim-routes.mjs [dropped-identity-change-check(linkWorkClaimPullRequest)] → **SURVIVED** — 28.9s; all 2 test file(s) pass

summary: 2 mutants, 0 killed, 2 survived, rest skipped/invalid
