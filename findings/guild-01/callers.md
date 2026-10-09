# Callers — who depends on the claim-core slice

Ranked by number of slice exports referenced (from
`findings/guild-01/dead-code-evidence.txt`, 2026-10-09).

## Production callers

| Caller | Uses |
|---|---|
| `server/work-claim-routes.mjs` | The whole machine: create/claim/renew/update/close/reassign/attest/review, leases, history, provenance, PR links, file-lease conflicts, event emission, integrity guards. |
| `server/claim-pr-sync.mjs` (20) | Poll loop: `pullRequestDue`, `rememberPoll`, `holdForRateLimit`, `nextPullBackoff`, `rateLimitUntil`, `usableEtag`, `recordPullOutcome`, `pullsReadyToSettle`, `batchPullOutcome`, `settlePullRequest`, `rollupClaimCi`, `parsePullRequestUrl`. |
| `server/needs-me.mjs` (4) | `readyClaims`, hard-work tags, named reviewers for the needs-me feed. |
| `server/land-queue.mjs` (1) | `closeWhenLive` (land/deploy auto-complete), `notePullMerged`. |
| `server/store.mjs` (2) | `createDurableWorkClaimRegistry`, `workClaimSchema` (RoomStore owns the registry). |
| `server/http.mjs` (1) | `handleWorkClaims` (route dispatch). |
| `server/mcp-full-profile.mjs` (3), `server/mcp-room-profile.mjs` (2) | `mirrorProjectionClaim` (MCP projection writes). |
| `server/claim-autolink.mjs` (3) | PR autolink → claim linking. |
| `server/governance.mjs` (2), `server/agent-fleet.mjs` (2), `server/agent-rooms.mjs` (1) | Claim queries for governance/fleet views. |
| `server/required-reading.mjs` (1) | `stampClaimHistory` / reading acks (W012). |
| `server/public-work-claims.mjs` (1) | Public read surface over the registry. |

## Test callers (heaviest)

`claims-state-machine.property.test.js` (5), `work-claim-leases.test.js`
(3), `claim-settle-1526.test.js` (2), `work-claim-guards.test.js` (2),
`work-claim-integrity.test.js` (2), `work-claim-events.test.js`,
`persisted-row.test.js`, `claim-scopes.test.js` — plus ~30 more
`work-claim-*.test.js` / `claim-*.test.js` files exercising the machine
through the routes.

## Blast radius notes

- `work-claims.mjs` is the most depended-on pure module in the server: any
  signature change ripples through routes, pr-sync, land-queue, MCP, and
  ~40 test files.
- `claim-pr-sync.mjs` is the only production consumer of the polling
  helpers — backoff/rate-limit changes affect only the tick.
- The registry has two implementations behind one shape (Map fixture vs
  SQLite durable); `RoomStore` owns the durable one.
