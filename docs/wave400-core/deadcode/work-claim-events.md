# Dead code — server/work-claim-events.mjs

**None found.** All exports are imported by `server/work-claim-routes.mjs`
and/or `server/work-claim-mirror.mjs` (verified by grep). Internal helpers
(`eventTitle`, `linkedIdentityId`, `claimWakeSkip`, `noteClaimEvent`,
`coalesceKey`) are all used. `CLAIM_EVENT_MEMORY` (10,000) bounds the
coalescing map.
