# server/work-claims.mjs — Work-claim state machine / registry

## Purpose

Pure, dependency-free state machine for agent work coordination. Work starts
unclaimed; one agent claims it, works it, and finishes or abandons it. Only
the claiming agent (or a claim manager via the route layer's `authority`
flag) may mutate its claim — everyone else's attempt is refused, never
half-applied. This is the anti-collision core: two agents cannot own the same
work item. Every transition returns a NEW frozen item; inputs are never
mutated. All inputs are validated with `ClaimError` ("invalid_claim_input");
ownership/round violations raise specific codes (work_not_owner,
work_claim_conflict, claim_lease_lapsed, work_claim_terminal).

## Public API

Constants (all frozen): `STATES` (unclaimed|claimed|in_progress|blocked|done|closed),
`CLAIM_LIFECYCLE` (state x verb -> next state), `TRANSITIONS` (state -> allowed
next states, close/cancel excluded), `CLAIM_VERBS`, `TERMINAL_CLAIM_STATES`,
`DELIVERY_MODES` (result|merged|production), `REVIEW_POLICIES`
(self_attested|distinct_member|independent_principal), `REVIEW_VERDICTS`,
`CLAIM_KINDS` (work|land|deploy), `CI_STATES`, `ACTIVE_CLAIM_STATES`
(claimed|in_progress|blocked), `DEFAULT_LEASE_HOURS` (24), `MAX_LEASE_HOURS`
(168), `DEFAULT_MAX_OPEN_CLAIMS` (200), `DEFAULT_MAX_MEMBER_OPEN_CLAIMS` (20),
`MAX_CLAIM_HISTORY` (200), `HARD_WORK_TAGS` (["hard","hard-problem"]),
`MAX_PROVENANCE_WALK` (200), `ClaimError` (Error subclass with `.code`).

Lifecycle mutations:
- `createWork(fields, { now, agentId })` — new item in `unclaimed`; validates
  notes (4000 chars), tags, files, dependsOn, PR links, repo/branch, kind/revision
  (deploy claims require a revision). Returns item stamped "created".
- `claimWork(work, agentId, { note, leaseHours, files, dependsOn, parentClaimId,
  evidenceRefs, pullRequest(s), repo, branch, fileBlocks, room, now })` —
  unclaimed -> claimed; refuses anything already owned (anti-collision); sets
  owner, claimedAt, lease window (default room config or 24h; `leaseHours: null`
  opts out, route-gated to owner/manage_claims).
- `updateWork(work, agentId, { state, note, deliveryMode, reviewedBy, tags,
  blobs, parentClaimId, evidenceRefs, now, authority })` — owner (or authority)
  state move per `TRANSITIONS`, or a note-only "noted" stamp. `deliveryMode`,
  `reviewedBy`, `tags`, `blobs` are refused unless `state === "done"`.
  Releasing (`state: "unclaimed"`) clears owner, lease, files, reviews,
  attestations — but NOT `claimedAt`, PR links, or CI (see Gotchas).
- `renewWork(work, agentId, { note, leaseHours, room, now })` — owner-only
  fresh lease window on an active, leased, unexpired claim; explicit
  `leaseHours: null` removes the lease. Route layer additionally requires the
  owner's public progress message before calling this.
- `closeWork(work, agentId, { verb, reason, now, authority })` — retire via
  `close` (holder or claim manager) or `cancel` (opener while unclaimed,
  holder, or manager); lands in terminal `closed`, owner/lease/files/reviews
  cleared, history stamped "closed"/"cancelled".
- `reassignWork(work, agentId, newOwner, { note, now, authority, room })` —
  owner hands work to another agent, same state; clears reviews/attestations.
  Reassigning an *unclaimed* item converts it to claimed with a fresh room-
  default lease (authority only, since owner is null).
- `appendWorkPullRequest(work, agentId, { pullRequest, expectedClaimedAt,
  expectedHistoryLength, now })` — compare-and-release PR link: refuses unless
  caller supplies the claim's current `claimedAt` and `claimHistoryLength()`
  (409 work_claim_conflict on stale replay; E5 failseq fix, 2026-10-08).
  Same-round duplicate URL is a byte-identical no-op; a PR outcome recorded
  before the current round (syncedAt <= claimedAt, tie resolved via
  ROUND_ENDED_ACTIONS history) is reset so the poller re-reads it.
- `attestWork(work, agentId, { note, now })` — caller-bound note; supersedes
  the member's active verdict but can never approve. Repeat identical note is
  a silent no-op (no history stamp).
- `recordReview(work, agentId, { verdict, summary, url, now })` — non-owner
  review (approve|changes_requested|comment), bound to the current review
  basis (owner, claimedAt, revision, CI head sha). Owner cannot review own
  claim. Approve also records a matching attestation used by the manual done
  policy. Replaying identical latest content never refreshes its binding.
- `canCloseWork(work, reviewerId, { policy, verifyMembers, reviewMembers })` —
  done-transition gate: self_attested = owner only; distinct_member =
  non-owner with a current approve + matching attestation + review membership;
  independent_principal additionally requires verify membership.
- `isLeaseExpired(work, now)` — active claim with `leaseExpiresAt <= now`.
- `releaseExpired(items, now)` — sweeps a list; expired claims auto-release to
  unclaimed (owner/lease/files/reviews/attestations cleared, "lease_expired"
  stamp). Returns a new list; inputs untouched.
- `roomWorkClaimConfig(room)` — per-room overrides
  `{ defaultLeaseHours, reviewPolicy, maxOpenClaims, maxMemberOpenClaims }`
  with safe fallbacks.
- `recordCi(work, ci, now)` — stores CI rollup; stamps history only on state
  change; returns `{ changed, item }`.
- `notePullMerged(work, mergedSha, now)` — land/deploy: records merge outcome
  on the PR link, sets revision for `closeWhenLive` to watch.
- `closeWhenLive(work, liveRevision, now)` — land/deploy claims auto-complete
  when the server's live revision matches claim revision or CI head sha;
  returns null when nothing to do. History stamp is "state:done" so receipts
  find it.
- `stampClaimHistory(work, agentId, { action, note, now })` — note-only stamp
  without a state transition (used by W012 required-reading acks).
- `summarizeClaimHistory(item, keep)` — board-list copy with trimmed history
  (+historyOmitted). `claimUpdatedAt(item)` — board sort key: max(updatedAt,
  last history stamp).
- `workOwnedBy(items, agentId)` / `unclaimedWork(items)` — list filters.
- `walkProvenance(items, rootId)` — BFS downstream claims via parentClaimId
  edges; cycle-safe, capped at MAX_PROVENANCE_WALK; returns
  `{ root, rootState, rootOwner, rootTitle, truncated, downstream }`.
- `flagPremiseInvalid(work, { premiseId, reason, byMemberId, now })` /
  `clearPremiseFlag(work, { byMemberId, note, now })` — mark/clear a bad-
  premise flag without changing state or outcome (works on done claims).
- `isReceiptTag(value)` — tag-shape predicate shared with the receipts route.
- `isHardWork(item)` / `namedReviewers(item)` / `resolveNamedReviewers(item,
  members)` / `hasCurrentReview(item, memberId)` — hard-problem pairing tags
  and rev-<member> tag resolution (dropped unless the tag names an ACTIVE
  member, so tags can't route wakes to outside identities).
- `creatorOf(work)` — creation-stamp author (null when history was trimmed).
- `isTerminalClaimState(state)`, `nextClaimState(state, verb)`.

## Claim state machine

```
                    claim        start          finish
   unclaimed  -------------->  claimed  ---------------->  in_progress  ------------>  done
      |  ^                       |  |  \                     |   |  \                   X terminal
      |  | release/              |  |   \ block               |   |   \ pause
      |  | lease_expired         |  |    \                    |   |    \
      |  |                       v  v     v                   v   v     v
      |  +------ pause/start ----+  +--> blocked ----------> claimed
      |                                                      (re-entry)
      +-- close/cancel (any state) ---------------------->  closed   X terminal
```

Full table (`CLAIM_LIFECYCLE`, state x verb -> next; anything unlisted is refused):

| state       | claim        | start        | block      | release    | pause      | finish | close   | cancel  |
|-------------|--------------|--------------|------------|------------|------------|--------|---------|---------|
| unclaimed   | -> claimed   | —            | —          | —          | —          | —      | -> closed | -> closed |
| claimed     | —            | -> in_progress | -> blocked | -> unclaimed | —        | —      | -> closed | -> closed |
| in_progress | —            | —            | -> blocked | —          | -> claimed | -> done | -> closed | -> closed |
| blocked     | —            | -> in_progress | —        | —          | -> claimed | —      | -> closed | -> closed |
| done        | —            | —            | —          | —          | —          | —      | —       | —       |
| closed      | —            | —            | —          | —          | —          | —      | —       | —       |

Triggers: `claim` = claimWork on unclaimed; `start` = updateWork state:in_progress;
`block` = updateWork state:blocked; `release` = updateWork state:unclaimed
(owner, or authority); `pause` = updateWork state:claimed; `finish` = updateWork
state:done (gated by canCloseWork at the route); `close`/`cancel` = closeWork
(own routes so retirement always records who + why). `done` = delivered;
`closed` = retired without delivery. Terminal states are immutable; only
open (non-terminal) items count against the room open-claim cap.

## Lease / expiry semantics

- Default 24h (`DEFAULT_LEASE_HOURS`), cap 168h (`MAX_LEASE_HOURS`), per-room
  override via `room.workClaims.defaultLeaseHours`. `leaseHours: null` opts out
  (never expires) — route-gated to room owner / manage_claims.
- `claimedAt` + `leaseStartAt` + `leaseExpiresAt` are stamped on claim;
  `isLeaseExpired` = active state AND `leaseExpiresAt <= now`.
- `releaseExpired(items, now)` auto-releases lapsed claims to unclaimed with a
  "lease_expired" stamp (driven by the board sweep in work-claim-routes and the
  claim-pr-sync poller). Lapsed leases cannot be renewed — claim again.
- `renewWork` starts a fresh window from now; owner-only, active-only,
  lease-required, unexpired-only. Route additionally demands the owner's
  public progress message (progressMessageId) before calling.

## Invariants

- Anti-collision: claimWork refuses non-unclaimed items; only the owner (or
  route `authority`) may update/release/reassign; every other attempt raises
  instead of half-applying.
- Immutability of outputs: every mutation returns a new frozen object; withHistory
  appends exactly one stamp per write and sets updatedAt.
- History cap: at most MAX_CLAIM_HISTORY (200) entries kept; overflow is
  counted in `historyOmitted`, and `claimHistoryLength()` = history.length +
  historyOmitted still changes on every write — this is the PR-link
  concurrency token.
- Compare-and-release: appendWorkPullRequest requires caller-supplied
  expectedClaimedAt + expectedHistoryLength matching the live item (409
  work_claim_conflict otherwise).
- Review binding: reviews/attestations are bound to a review basis
  { owner, claimedAt, revision, CI headSha }; a re-claim, new head, or new
  revision makes them stale (hasCurrentReview / currentReviewBasis). Release
  and close clear reviews + attestations — they belong to the lapsed owner's
  round, never the next holder's.
- Terminality: done/closed are refused by updateWork, recordReview, attestWork,
  reassignWork, closeWork. tags/blobs/deliveryMode/reviewedBy exist only on
  the done transition.
- Provenance is work-level (survives release); the done transition freezes the
  final values onto the receipt. The premise flag never changes state/outcome.
- Note bounds: create/claim/renew/update notes <= 4000 chars (SEC2/QA D-1);
  attestation notes <= 512; chain notes <= 2000.
- Superseded claims (`item.supersededBy`) cannot receive PR links.

## Top callers

- `server/work-claim-routes.mjs` — HTTP layer for all claim routes (create,
  claim, update, renew, close/cancel, reassign, review, attest, provenance,
  premise-invalid, appendPullRequest, receipts search, board lists, sweep).
- `server/routes/work-claims.mjs` — `createWorkClaimRegistry()` wrapper +
  per-request sweep via releaseExpired.
- `server/claim-pr-sync.mjs` — PR poller: recordCi, notePullMerged,
  closeWhenLive, releaseExpired.
- `server/work-claim-sqlite.mjs` — SQLite persistence (work_claims table) +
  room config via roomWorkClaimConfig.
- `server/mcp-hosted-tools.mjs`, `server/mcp-room-profile.mjs` — MCP tools
  (walkProvenance, ClaimError).
- `server/public-work-claims.mjs` — public surface (renewWork, releaseExpired).
- `server/needs-me.mjs` — isHardWork, namedReviewers/resolveNamedReviewers,
  hasCurrentReview, claimUpdatedAt, ACTIVE_CLAIM_STATES.
- `server/work-claim-events.mjs` — resolveNamedReviewers, hasCurrentReview
  (wake routing).
- `server/required-reading.mjs` — stampClaimHistory, ClaimError (W012 acks).
- `server/land-queue.mjs` — roomWorkClaimConfig, ACTIVE_CLAIM_STATES.
- `client/work-actions.mjs`, `client/room-agent.mjs` — client-side actions.

## Gotchas

- Outputs are frozen NEW objects — callers must use the return value; mutating
  the input is impossible and silently ignoring the return loses the write.
- `releaseExpired` normalizes (workOf) EVERY item in the list, expired or not —
  pass-through items come back as frozen copies (work-claim-routes' sweep
  compares states to find which actually lapsed).
- Release paths (updateWork state:unclaimed, releaseExpired, closeWork) clear
  files/reviews/attestations but KEEP `claimedAt`, PR links (`pullRequest`/
  `pullRequests`), CI, chain, supersededBy — the next owner inherits the old
  owner's PR observations. Flagged as a suspected inconsistency in bugs/.
- `updateWork` with `state` equal to the current state is REFUSED (the
  TRANSITIONS row doesn't list self-loops); note-only updates must omit
  `state`.
- `close`/`cancel` are NOT in TRANSITIONS — they have dedicated routes; the
  update route can never retire a claim.
- appendWorkPullRequest's no-op returns the raw input (un-normalized), while
  the mutating path returns a normalized object.
- `creatorOf` returns null once history trimming drops the "created" stamp —
  closeWork's cancel-by-opener check then fails closed.
- `attestWork`'s duplicate-note path returns the item with NO history stamp —
  the route must not assume every call produced a room event.
- `canCloseWork` self_attested is owner-only but still needs a non-terminal,
  claimed, owned item; unknown policies throw (programmer error), identity
  mismatches just return false.
- `closeWhenLive` can complete a `blocked` claim and keeps owner/lease fields;
  it only matches liveRevision against claim revision or CI headSha.
- `claimUpdatedAt` prefers the last history stamp over stored updatedAt — a
  writer that appended history without refreshing updatedAt still sorts
  correctly.

## Stale comments

- `server/work-claims.mjs:7` — "Persistence is a later slice." STALE:
  `server/work-claim-sqlite.mjs` persists `work_claims` per room to SQLite
  (upsert/select by room_id + claim_id) and per-room config.
- `server/work-claims.mjs:4` — "Only the claiming agent may update, release,
  or reassign its work — anyone else's attempt is refused". STALE/overstated:
  updateWork, reassignWork, and closeWork all accept `authority = true`
  (claim managers: room owner or manage_claims), and work-claim-routes calls
  updateWork with `authority` to pause/release others' claims (routes ~1176-1179).
- `server/work-claims.mjs:691` (updateWork header) — "Only the owner may
  update." Same overstatement: the function takes `authority` and the route
  uses it for manager pause/release.
- `server/work-claims.mjs:877` (reassignWork header) — "the owner hands
  work to another agent (stays in the same state)". Understated: authority
  can also reassign (and unclaimed items become claimed with a fresh lease).
