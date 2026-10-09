# Handoff Protocol — Compatibility / Diff Checklist (GUILD-01, COORD-300)

**Branch:** `coord300/guild-01` · **Basis:** origin/main @ `4ad56feaa` (fetched 2026-10-09)
**Direction:** Dot (John's orchestration authority), room seq 8263 — re-aim from "build new"
to "repair observed coordination failures". Additive, offline, fixture-backed only.
**Not a competing protocol.** Nothing here replaces the current board/protocol.

## 1. Released-vs-done semantics (pinned down)

Three claim systems use the word "released" with different meanings:

| System | "released" means | "done" means | Where |
|---|---|---|---|
| Board work-claims (`server/work-claims.mjs`) | NOT a state. The `release` **verb** → state `unclaimed` (owner cleared, lease cleared, attestations/reviews/files dropped — they belong to the lapsed owner's round). The event is `released` / `claim.released`. | Terminal. Work delivered; keeps its owner (the deliverer); freezes `deliveryMode`, `tags`, `blobs`. Immutable. | `server/work-claims.mjs:43-56` (CLAIM_LIFECYCLE), `updateWork` release branch |
| Room claims — collision detector (`server/claim-collisions.mjs`) | A **closed status**: claims in `released` no longer hold files, same as `done`. | A closed status: no longer holds files. | `CLOSED_STATUSES`, line 18 |
| Reputation observer (`server/claim-reputation.mjs`) | Priced event `claim_released` (neutral; closes the open position). Distinct from `claim_flaked` (lease expiry — observable flake) and `claim_completed` (done). | Priced event `claim_completed`. | cases `"released"` / `"done"` / `"lease_expired"` |
| Inbox handoff (`server/inbox-handoff.mjs`) | **Terminal status** alongside `completed`. | n/a (uses `completed`) | `inboxHandoffStatuses`, `terminalStatuses` |
| Typed handoff envelopes (`server/work-handoff.mjs`) | Does not exist. Terminal: `completed, rejected, expired, escalated, cancelled`. | n/a (uses `completed`) | `envelopeTerminal` |
| Docs (`docs/WORK-CLAIMS.md` states table) | Written as `released (unclaimed)` — the parenthetical disambiguates, but readers scanning for a state named `released` will misread it. | `done` (immutable). | docs/WORK-CLAIMS.md:43 |

**Compatibility note (not a bug):** a `done` claim and a `released`-to-`unclaimed` claim are
treated identically by collision detection (neither holds files) but oppositely by reputation
(completed vs released) and by the state machine (done keeps owner, is immutable; unclaimed is
re-claimable). Any consumer that conflates "released" with "done" (e.g. a dashboard counting
"finished" work) will misreport. The docs table's `released (unclaimed)` notation is the one
place the ambiguity leaks into documentation.

## 2. Round-bound retries (pinned down per route)

"Round" = the claim round: `claimedAt` + history length (`expectedClaimedAt` +
`expectedHistoryLength`). A stale round is `409 work_claim_conflict`.

| Route | Round binding deployed | Status |
|---|---|---|
| `POST /work-claims/:id/claim` | None — state guard only (`409 work_claim_conflict` names the holder, #2084) | P2 — accepted |
| `POST /:id/update` — plain note | OPT-IN (#2078). Absent preconditions → legacy silent apply. | As designed (opt-in) |
| `POST /:id/update` — `state: "done"` (the finish path) | **OPT-IN (#2078). Absent preconditions → legacy silent apply.** | **GAP — see §3** |
| `POST /:id/release` | REQUIRED (#2088, E5/D4 compare-and-release) | FIXED on main |
| `POST /:id/reassign` | REQUIRED (#2262) | FIXED on main |
| `POST /:id/appendPullRequest` | REQUIRED | Bound |
| `POST /:id/renew` | Owner check + lapsed-lease 409 (`claim_lease_lapsed`, QA-200 H4) | Bound by ownership |
| `requestId` replay dedup on `/update` | OPT-IN (PRODUCT-200 A4, AQ-HI-06). Replay with same requestId → stored outcome, no new write. | Partial: clients that don't send requestId get no retry protection |

**Deployed-vs-documented gaps:**
1. `docs/WORK-CLAIMS.md` ("After an unknown response… retry only with fresh preconditions after
   checking the same owner/round") documents the round-bound retry discipline as **the**
   discipline, while the deployed default on `/update` is **opt-in** — a legacy client that
   omits preconditions gets silent apply, not a refusal. The doc describes the intended
   discipline; the code preserves the legacy behavior. **Doc and code disagree on the default.**
2. `docs/PRODUCT200-IDEMPOTENCY-MATRIX.md` (anchor `be7ce3b17`, 2026-10-08) is stale in two
   rows: it says `/reassign` has "No round token" (fixed by #2262 after the anchor) and
   `/update` has "no replay dedup" (opt-in `requestId` dedup landed via A4 after the anchor).
   The matrix's risk #1 ("blind retry of a timed-out update → duplicate history entry", QA-200
   s7-r2 BUG-2) is now **partially** covered (opt-in dedup), not fully.
3. `docs/CLIENT-RETRY-DISCIPLINE.md` documents the split-brain retry discipline; the `/update`
   done path is the one mutating route in the work-claims family whose safe retry still
   depends entirely on client discipline rather than a server-enforced round binding.

## 3. The observed failure (GUILD-01 finding)

**A `done` prepared against claim round N, retried after the claim was released and
re-claimed (round N+1, same owner), with no `expectedClaimedAt`/`expectedHistoryLength`
preconditions, returns 200 and marks round N+1 `done`.** The fresh round's work is falsely
completed — the exact stale-self-retry class E5/D4 fixed for `/release` (#2088) and
`/reassign` (#2262), still open on the finish path.

Reproduced against the real route handler (`server/work-claim-routes.mjs handleWorkClaims`,
in-memory registry, offline) — see `examples/stale-done-retry.mjs`:
- stale done, no preconditions → **200**, round 2 marked done (claimedAt = round-2 timestamp)
- control: same stale done with stale preconditions → **409** `work_claim_conflict`, round 2 untouched

Fail-first test: `tests/stale-done-round-boundary.test.js`
- asserts a round-N `done` must never complete round N+1 → **FAILS on current code** (negative control)
- asserts the 409 control → passes on current code
- re-runs the failing property against a test-time "strengthened" route copy (done requires
  round binding) → **PASSES**, proving the candidate fix repairs it
- candidate fix shipped as `fixes/candidate-require-round-binding-on-done.patch` (one line,
  not applied to the tree — additive evidence, unlanded)

## 4. Integration dependencies

- `server/work-claim-routes.mjs` — `handleWorkClaims`, `createWorkClaimRegistry`
  (the only production modules under test; driven, not modified)
- `server/work-claims.mjs` — `claimHistoryLength`, `CLAIM_LIFECYCLE` (pure machine)
- `server/service-error.mjs` — `ServiceError` (route refusal shape)
- Test-frame convention: `tests/chaos/claim-race-ops.mjs` (P4/P5 route-level harness,
  fail-first weakening pattern — this guild's test follows the same shape but asserts
  the done path)
- Docs cross-checks: `docs/WORK-CLAIMS.md`, `docs/PRODUCT200-IDEMPOTENCY-MATRIX.md`,
  `docs/CLIENT-RETRY-DISCIPLINE.md`, QA-200 failseq E5/D4 (#2088), #2262

## 5. What is NOT proven

- The fix is a **candidate patch only** — one line, not applied, not landed, not reviewed.
  Whether `/update`'s done path *should* require round binding (breaking legacy clients that
  omit preconditions) is a protocol decision for John/Dot, not this guild. The patch is
  evidence + a starting diff for a future PR (which this guild will not open).
- All measurements are **offline fixtures** (in-memory registry, seeded sequences). Not
  proven against the live Durable Object store, concurrent HTTP serialization, or the
  deployed room.
- Reputation/journal/wake side effects of a false done (a `claim_completed` priced for work
  never delivered, owner woken) were **not** measured — the reproduction stops at the route
  response + item state.
- The checklist asserts doc-vs-code gaps from reading; it does not prove any live client
  actually omits preconditions on done retries today.
- `requestId` opt-in dedup (A4) interacts with round binding: a retry with the same
  requestId replays the stored outcome even across a round change (the route checks the
  requestId replay *before* the stale-basis precondition). That ordering choice is
  deliberate in code; this guild did not evaluate whether it is correct.
