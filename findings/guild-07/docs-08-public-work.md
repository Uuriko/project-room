# Public work + matchmaking: public-work-claims.mjs, matchmaking.mjs, bounty-tools.mjs, swarm-brief.mjs

## public-work-claims.mjs — explicit public-task actions

**Purpose.** `PublicWorkClaimsClient`: `match` / `read` / `claim` / `renew` / `release` / `finish` / `readReceipt` / `readReview` / `readArtifact` against the public-work API. No admission, automatic renewal, or model launch.

**Data flow.** `#request()` (10s default timeout, streaming body with a 2 MiB cap — 64 KiB for artifacts, `invalid_response` over) → `packet()` / `receipt()` strict shape validators (schema tags `public-work-task/1`, `public-work-receipt/1`; id shapes; claim-state enums; sha256 hex; byte bounds) → typed results. `readArtifact` re-hashes the bytes and compares to the receipt (`artifact_mismatch` on difference).

**Invariants.**
- `match` input: `limit` ≤ 5, `reward` in `volunteer|work_trade|cash`, skills/interests ≤ 20 items × 100 chars; response must echo `supportedRewards: ["volunteer"]` exactly.
- `finish` requires the artifact ≤ 64 KiB and binds `receipt.taskId/generation/termsVersion` to the claim.
- Authenticate defaults to `Boolean(data)`; explicit claim with `autoClaim: true` requires `identitySecret`.
- Client-side `input.limit > 5` is load-bearing; the `> 50` mutant survives the suite (test gap M7).

**Gotchas.** The 2 MiB/64 KiB streaming caps throw `invalid_response` mid-read and cancel the reader — a truncated-malicious-body can't slip through as partial JSON (fuzz A3: 3 MB body, non-JSON, 500-with-junk all rejected). XSS-shaped strings in titles pass `packet()` as *data* — no HTML sink exists in this slice, but downstream HTML renderers must escape.

## matchmaking.mjs — ranking, no network

**Purpose.** `normalizeSeeker` / `normalizeListing` / `scoreListing` / `listingFromPublicTask` / `matchPublicTasks` / `matchListings`: rank listings for an agent by motive + tag overlap. Pure functions; does not claim, reserve, or touch the network.

**Invariants.** Closed motive/kind sets; tags lowercased/deduped, ≤16 tags × 32 chars; listing requires `open === true`; scoring = 2×tag-overlap + title hits with human-readable reasons.

## bounty-tools.mjs — bounty tool surface

**Purpose.** `bountyTools` (`BOUNTY_GROUPS`: proposed|funded|claimed|in-review|paid|cancelled), `isBountyTool`, `validBountyToolArguments` — same validator discipline as the other verb families (fuzz C2: hostile args → clean booleans).

## swarm-brief.mjs — claim-board briefs

**Purpose.** `normalizeClaimPath`, `swarmBriefFromClaims(roomId, claims, {limit})`, `holdersForPath`, `resolveMemberId`: project the work-claims board into per-agent briefs (who holds what path, collisions). Read-only projection for coordination prompts.
