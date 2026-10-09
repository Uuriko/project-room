# server/work-claims.mjs — the pure work-claim state machine

Anti-collision core of Project Room's agent coordination (B006/B007). Pure,
dependency-free (except `parsePullRequestUrl` from claim-coordination.mjs),
deterministic. Every function takes plain data and returns new frozen data —
inputs are never mutated. All validation failures throw `ClaimError`
(`code: "invalid_claim_input"` for bad input; other codes listed per function).

## State machine

States: `unclaimed → claimed → in_progress → done`, with `blocked` as a
side state and `closed` as terminal-without-delivery.

```
unclaimed:  claim→claimed, close→closed, cancel→closed
claimed:    start→in_progress, block→blocked, release→unclaimed,
            close→closed, cancel→closed
in_progress: block→blocked, finish→done, pause→claimed,
            close→closed, cancel→closed
blocked:    start→in_progress, pause→claimed, close→closed, cancel→closed
done:       (terminal — immutable)
closed:     (terminal — immutable)
```

`CLAIM_LIFECYCLE` is the single explicit table; `nextClaimState(state, verb)`
derives the next state or null. `TRANSITIONS` is the `/update`-route subset
(close/cancel have dedicated routes so retirement always records who/why).

**Only the claiming agent** may update, release, renew, or reassign its work.
Anyone else's attempt is refused, never half-applied. Two agents cannot both
own the same item: `claimWork` on a non-`unclaimed` item throws.

## Claim kinds

`kind` ∈ `work | land | deploy` (default `work`). `deploy` claims require a
`revision`. `closeWhenLive(work, liveRevision)` auto-completes land/deploy
claims when the live server reaches their revision (or CI head sha).

## Leases

- Default 24h (`DEFAULT_LEASE_HOURS`), cap 168h (`MAX_LEASE_HOURS`).
- `leaseHours: null` opts out — the claim never expires (route-gated to
  owner/manage_claims).
- `isLeaseExpired(work, now)`: active state + `leaseExpiresAt <= now`.
- `releaseExpired(items, now)`: auto-releases lapsed claims to `unclaimed`,
  clearing owner, lease, files, fileBlocks, attestations, reviews — the next
  claimant starts clean. History stamp `lease_expired` names the lapsed owner.
- `renewWork`: owner-only, active states only, requires an un-lapsed lease.
  Starts a fresh window from `now` (explicit `leaseHours`, else the room
  default — **not** the claim's original lease). `leaseHours: null` clears
  the lease, mirroring `claimWork`.
- Per-room overrides via `roomWorkClaimConfig(room)`: rooms carrying
  `workClaims = { defaultLeaseHours, reviewPolicy, maxOpenClaims,
  maxMemberOpenClaims }`; invalid values fall back to defaults
  (200 / 20 open-claim caps, `self_attested` policy).

## History (SEC-2)

Every write appends one frozen stamp `{at, agentId, action, note}` via
`withHistory`. At most `MAX_CLAIM_HISTORY` (200) entries are kept; older ones
are dropped from the front and counted in `historyOmitted`, so
`claimHistoryLength(item) = history.length + historyOmitted` still changes on
every write — the PR-link concurrency check reads it. `stampClaimHistory`
appends a note-only stamp; `summarizeClaimHistory(item, keep)` trims for
board lists. `claimUpdatedAt(item)` = max(last history stamp, `updatedAt`).

Round-ending actions (a new claim round may start after each):
`pr_closed`, `pr_merged`, `state:unclaimed`, `lease_expired` — used by
`appendWorkPullRequest`'s stale-outcome tie-break.

## Key functions

| Function | Contract |
|---|---|
| `createWork(fields, {now, agentId})` | New `unclaimed` item. Note ≤4000 chars. Tags allowed up front; **blobs are silently dropped** (only recorded on done). Deploy kind needs revision. |
| `claimWork(work, agentId, opts)` | `unclaimed`→`claimed` + lease. Refuses held work with a message naming the holder (H4/QA-200). Note ≤4000. |
| `renewWork(work, agentId, {leaseHours, room, now})` | Fresh lease from now. Lapsed lease → re-claim, never renew. |
| `appendWorkPullRequest(work, agentId, {pullRequest, expectedClaimedAt, expectedHistoryLength, now})` | Compare-and-set PR link (E5/#2088): owner-only, active, unsuperseded, un-lapsed lease, claimedAt+historyLength must match the read. Same-round duplicate = byte-identical no-op. Stale outcome (syncedAt < claimedAt, ties broken by round-ending stamps or ≥2 `claimed` stamps) resets the link. |
| `updateWork(work, agentId, {state, note, deliveryMode, reviewedBy, tags, blobs, …, authority})` | State moves per TRANSITIONS or note-only. Release clears owner/lease/files/attestations/reviews. `deliveryMode/reviewedBy/tags/blobs` only on `state:"done"`, then frozen. |
| `closeWork(work, agentId, {verb, reason, authority})` | `close`: holder or claim manager. `cancel`: opener (while unclaimed), holder, or manager. Terminal `closed`, owner/lease cleared. |
| `reassignWork(work, agentId, newOwner, {authority, room})` | Owner (or manager) hands off; stays in state. Attestations/reviews cleared. Assigning an `unclaimed` item claims it with a fresh room-default lease. |
| `attestWork` | Caller's own note; one attestation per reviewer per round+revision (repeat on same basis replaces in place, no history stamp). Cannot approve. |
| `recordReview` | Non-owner review; latest per member wins. `approve` also records the caller-bound attestation used by the manual done policy. Replaying identical content is a no-op. |
| `canCloseWork(work, reviewerId, {policy, verifyMembers, reviewMembers})` | Review-policy gate for done. `self_attested`: reviewer is owner. Otherwise: non-owner with a current `approve` on the current basis (owner/claimedAt/revision/CI head), matching attestation timestamp, in reviewMembers (+ verifyMembers for `independent_principal`). Unknown policies throw. |
| `closeWhenLive` | Land/deploy → done when live revision matches revision or CI head sha. |
| `recordCi` | CI rollup; history stamped only on state change. |
| `notePullMerged` | Records merge commit as the revision the live server must reach. |
| `flagPremiseInvalid` / `clearPremiseFlag` | Marks a claim's premise invalid without changing state; auditable flag cycle. |
| `walkProvenance(items, rootId)` | BFS downstream via `parentClaimId`, cycle-safe, capped at `MAX_PROVENANCE_WALK` (200). |
| `workOwnedBy` / `unclaimedWork` | List filters. |
| `isHardWork` / `namedReviewers` / `resolveNamedReviewers` / `hasCurrentReview` | Hard-Problems board: `hard`/`hard-problem` tags pair up; `rev-<member>` tags route review wakes to active members only (never outside the room). |

## Validation helpers (all throw `invalid_claim_input`)

`tagsOf` (≤10, `[A-Za-z0-9_-]{1,32}`), `blobsOf` (≤10, `sha256:<64hex>`),
`claimedFilesOf` (≤64 repo-relative paths, `..`/absolute refused; whole-file
entry wins over block labels), `dependsOnOf` (≤16, no self-deps),
`parentClaimIdOf`, `evidenceRefsOf` (≤16, `sha256:` or credential-free
`https://`), `pullRequestOf`/`pullRequestsOf` (≤16, canonical GitHub URLs;
client may only name the URL — outcome/CI/poll fields are server-owned),
`chainOf` (≤20 handoff/supersede links), `reviewsOf` (≤50), `attestationOf`,
`reviewBasisOf` (version 1: owner/claimedAt/revision/headSha binding),
`readingAcksOf` (W012 required-reading acks, latest per agent wins).

## Invariants (fuzz-pinned, 2026-10-09)

- No double-claim win: 500 concurrent `claimWork` attempts → exactly 1 winner.
- Invalid transitions throw; terminal states immutable; non-owner writes refused.
- Lease math exact: `leaseExpiresAt = now + hours·3600·1000`; monotonic for forward time.
- Size bombs refused at documented bounds (4000-char notes, 10 tags, 64 files,
  16 PRs, 16 dependsOn, 200 history entries).
- `parsePullRequestUrl` never throws; rejects query/fragment/credentials/ports
  (non-default), non-github hosts, `pull/0`; canonicalizes trailing slash,
  default port, case, whitespace.
- `settlePullRequest` never settles a lapsed lease (#1526 B2).
- SQLite registry survives `kill -9` mid-upsert: `integrity_check` ok, no torn rows.
