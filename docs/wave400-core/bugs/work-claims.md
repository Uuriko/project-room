# Suspected bugs — server/work-claims.mjs

Do NOT fix. All line numbers are against origin/main c5d1c313a
(branch wave400/docs-core). Checked the full file (1053 lines) plus the
store commit path in server/work-claim-routes.mjs and the route guards.

## Race conditions

- `server/work-claims.mjs:627` (appendWorkPullRequest) + `server/work-claim-routes.mjs:702`
  (commit -> registry.set) — the compare-and-release (expectedClaimedAt +
  expectedHistoryLength) guards only a STALE CALLER, not concurrent writers.
  The route does registry.get -> appendWorkPullRequest -> registry.set with a
  blind upsert; the tokens are caller-supplied in the POST body (routes
  554-563). Two concurrent requests from two fresh callers both pass their
  tokens and the last write silently drops the other's history stamps. The
  E5 fix (2026-10-08) closed the stale-self-retry case; the concurrent-writer
  case is still last-write-wins at the store layer. Suggested direction (for
  an owner): compare-and-set on history length inside registry.set.
- `server/work-claims.mjs:618` — appendWorkPullRequest rejects when
  `item.supersededBy` is set, but `claimWork` (`server/work-claims.mjs:584`)
  does not check `supersededBy` — a superseded claim can still be claimed by
  a new owner. Low impact (supersede is a chain convention), but the two
  guards disagree.

## Release / reclaim paths (stale state)

- `server/work-claims.mjs:727-744` (updateWork release branch),
  `server/work-claims.mjs:904-916` (releaseExpired),
  `server/work-claims.mjs:759-768` (closeWork) — none of the release/retire
  paths clear `claimedAt`. A released (unclaimed) or closed item keeps the
  previous round's claimedAt, visible on board reads. claimWork overwrites it
  on the next claim, so the window is "unclaimed/closed item with someone
  else's claimedAt"; appendWorkPullRequest compares claimedAt only after a
  fresh claim, so the main risk is misleading reads, not a logic break.
- `server/work-claims.mjs:727-744` (updateWork release) and
  `server/work-claims.mjs:904-916` (releaseExpired) — a release drops the
  lapsed owner's files, reviews, and attestations (comment: "attestations
  belong to the lapsed owner's round, never to whoever claims next"), but
  KEEPS `pullRequests`/`pullRequest` and `ci`. The next owner inherits the
  previous owner's PR links and CI observations — arguably as owner-specific
  as files. Inconsistent with the stated "whoever claims next starts clean"
  intent. If deliberate, the comment should say so.
- `server/work-claims.mjs:627` — the byte-identical no-op path returns the
  raw `work` input (`return work;`) instead of the normalized `item`
  (workOf). The mutating path returns a fully normalized object. Callers
  comparing shapes across the two paths can see un-normalized passthrough
  (e.g. unknown fields, un-frozen arrays) on the no-op path only.

## Review / attestation edge cases

- `server/work-claims.mjs:792` (attestWork) — the duplicate-note early
  return (`return Object.freeze(item)`) produces no history stamp and no
  updatedAt change. The route layer must not assume every attest call
  emitted a room event; the code is correct, the hazard is for callers.
  (recorded here because the route at work-claim-routes.mjs:1139 coalesces on
  this path — verified consistent.)
- `server/work-claims.mjs:831` (recordReview) — a re-attestation by the
  same member keeps the ORIGINAL `at` (`prior.at` in attestWork's in-place
  replace, `server/work-claims.mjs:798`). canCloseWork requires
  `attestation.at === review.at`; a member who attested at T1 and then got an
  approve recorded at T2 gets a fresh attestation at T2 (recordReview filters
  then appends), so this path is consistent — but the attestWork in-place
  replace path is what keeps the old `at`, which is deliberate per the
  SEC-2 comment. No bug found, noted as checked.

## Lease semantics

- `server/work-claims.mjs:896-900` (isLeaseExpired) — expiry is inclusive:
  `Date.parse(item.leaseExpiresAt) <= nowMs`. A lease lapses exactly at the
  deadline, not after. Documented behavior; flagged only because renewWork
  uses strict `>` (`Date.parse(item.leaseExpiresAt) > atMs`) — consistent
  (renew at exactly the deadline is refused, then sweep releases it), but the
  two formulations should stay in sync if either changes.
- `server/work-claims.mjs:563-597` (claimWork) — when `leaseHours` is
  explicitly `null` the claim carries no lease and `note ?? "lease: ..."`.
  If a caller passes `leaseHours: null` intending "room default", they get
  no-lease instead. leaseHoursOf treats null as opt-out; `undefined` is the
  default path. The route converts absent -> undefined (leaseHoursOfBody),
  so this is correct at the route; a direct pure-function caller must know
  the null/undefined distinction. API-shape hazard, not a code bug.

## Checked, no bug found

- TRANSITIONS table: all 8 verbs x 6 states verified against the file's table;
  done/closed rows are empty (immutable); updateWork excludes close/cancel
  from TRANSITIONS and the routes handle them via closeWork — no path lets the
  /update route retire a claim.
- withHistory / MAX_CLAIM_HISTORY trim: `historyOmitted` accumulates dropped
  count; claimHistoryLength stays monotonic per write. creatorOf fails closed
  (null) once the "created" stamp is trimmed — cancel-by-opener then refuses,
  which is the safe direction.
- walkProvenance: visited set + MAX_PROVENANCE_WALK cap; the outer while
  checks `!truncated`, so the loop cannot run past the cap.
- canCloseWork: terminal/unclaimed/ownerless rejected up front; owner excluded
  for non-self policies; approve verdict + current basis + matching
  attestation.at + review/verify membership all required. Unknown policy
  throws (fail-fast for programmer error).
- renewWork: owner-only, active-only, lease-required, unexpired-only;
  explicit null removes the lease. Route additionally requires the owner's
  public progress message (progressMessageId) — verified present at
  work-claim-routes.mjs:1224-1263.
- Null-lease opt-out gated to room owner / manage_claims — verified at
  work-claim-routes.mjs:763-764.
- closeWhenLive: returns null for non-land/deploy, terminal, empty revision,
  or revision mismatch; does not gate on review policy (deliberate per
  comment — auto-settlement, not manual completion).
- reassignWork on unclaimed converts to claimed with a fresh room-default
  lease and requires authority (owner is null) — consistent with the comment.
- Note-length bounds (4000 create/claim/renew/update/close, 512 attest,
  2000 chain/premise) present on all stamp paths; evidenceRefs reject
  non-https URLs and URLs with credentials.
