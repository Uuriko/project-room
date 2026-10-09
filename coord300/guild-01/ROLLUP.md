# COORD-300 GUILD-01 — Coordinator Rollup (Dot redirect)

**Branch head SHA:** `4d270ef9fe9b43a3ee5661cf7a0514cf7488e6c1` (branch `coord300/guild-01`,
worktree `~/workspace/pr-coord300-guild-01/`). ROLLUP.md itself is a second commit —
see `git log` for the final head.
**Direction:** Dot (John's orchestration authority), relayed via parent, citing room seq 8263.
Acknowledged: mission re-aimed from "build protocol v2" to "repair observed coordination
failures". Additive, offline, fixture-backed. No workers launched (redirect forbids).
No GUILD-CHARTER posted (mission re-aimed before charter; predecessor never posted one).

## What was built (all under `coord300/guild-01/`, additive only)

| File | What |
|---|---|
| `HANDOFF-PROTOCOL-CHECKLIST.md` | Compatibility/diff checklist: released-vs-done semantics across 5 claim systems; round-bound retries per route (deployed vs documented); observed failure; integration deps; "what is NOT proven" |
| `tests/stale-done-round-boundary.test.js` | Runnable fail-first test, 5 tests, route-level against the real `handleWorkClaims` |
| `examples/stale-done-retry.mjs` | Executable demo printing the A/B cases |
| `fixes/candidate-require-round-binding-on-done.patch` | One-line candidate fix, `git apply --check` clean, NOT applied to the tree |
| `scratch/guild.log` (worktree root) | Decision log incl. redirect acknowledgment |

## Measured numbers (evidence)

Reproduced against the real route handler, in-memory registry, offline:

- **Stale done, no preconditions → 200**, round-2 claim marked `done`
  (claimedAt = round-2 timestamp; fresh work falsely completed). **Gap reproduced.**
- Control: same stale done with stale preconditions → **409** `work_claim_conflict`,
  round 2 stays `in_progress`. (The round mechanism works when clients use it.)
- Test run `node --test coord300/guild-01/tests/stale-done-round-boundary.test.js`:
  **4 pass / 1 fail** — the single failure is the intentional negative control
  ("stale done must be refused, got 200"), failing because the fix is absent.
- Same suite against the test-time strengthened copy (done requires round binding):
  **5 pass / 0 fail** — negative control + happy path both green, proving the
  candidate fix repairs the failure without breaking the fresh-done path.
- Example run: `A  stale done, no preconditions : 200 | round-2 state = done` /
  `B  stale done, stale preconditions: 409 | round-2 state = in_progress`.

## Pinned-down semantics (summary)

- **Released-vs-done:** board work-claims: `release` is a verb → `unclaimed` (owner/lease/
  attestations/files cleared); `done` is terminal, keeps owner, freezes receipt fields.
  Collisions treat `released`+`done` alike (no file holding); reputation prices them
  oppositely (`claim_released` vs `claim_completed`; lease-expiry = `claim_flaked`).
  Inbox handoff: `released` is terminal; handoff envelopes have no `released`.
  Docs `released (unclaimed)` notation is the ambiguity leak.
- **Round-bound retries:** `/release` REQUIRED (#2088), `/reassign` REQUIRED (#2262),
  `appendPullRequest` REQUIRED, `/update` note+state OPT-IN (#2078), `requestId`
  replay dedup OPT-IN (A4). The `done` transition is the one mutating path still
  client-discipline-only.
- **Deployed-vs-documented gaps:** WORK-CLAIMS.md documents round-bound retry as the
  discipline while the deployed default is opt-in; PRODUCT200-IDEMPOTENCY-MATRIX.md is
  stale on 2 rows (reassign now round-bound; update now has opt-in requestId dedup).

## Caveats / what is NOT proven

- The fix is a **candidate patch only** — unlanded, unreviewed. Whether `done` should
  *require* round binding (breaking legacy clients that omit preconditions) is a
  protocol decision for John/Dot. This guild opens no PRs.
- All evidence is **offline fixtures** (in-memory registry). Not proven against the live
  Durable Object store or concurrent HTTP serialization.
- Reputation/wake side effects of a false done were not measured.
- No claim is made about live clients omitting preconditions on done retries today.
- Room posting: no GUILD-CHARTER and no room DONE-ROLLUP were posted from this
  subagent (no enrolled room identity / browser). This file + the parent report are
  the rollup; the parent decides on room posting.
- Redirect provenance: the Dot redirect arrived via the internal handoff channel, not
  as a verifiable room post; seq 8263 could not be independently confirmed from here.
  Treated as authoritative per subagent instructions; flagged for the parent.
