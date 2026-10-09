# Re-verification — guild-06 (scripts-rest)

Head at setup: `a436d0cac`. Note: **no `wave300/*`, `wave400/*`, or `wave500/*`
branch touches this slice** (verified: all 32 branches diffed against their
merge-base with origin/main — zero files under `scripts/` outside the guild-05
exclusions). The program's rebase-a-wave-branch step has no target; instead:
(1) full affected suites re-run on a scratch worktree at current origin/main
(`6e03ee51e`), and (2) adversarial review of the 4 most logic-heavy main
commits that landed on the slice since setup.

## 1. Suite re-runs on current origin/main (rev-01..06)

All in disposable worktrees at `6e03ee51e`, worktree-local TMPDIR. All PASS:

| unit | test file | result |
|---|---|---|
| rev-01 | tests/bounty-conservation-check.test.js | PASS |
| rev-02 | tests/dependency-audit.test.js | PASS |
| rev-03 | tests/flaky-detect.test.js | PASS |
| rev-04 | tests/journey-coverage.test.js | PASS |
| rev-05 | tests/openapi-method-accuracy.test.js | PASS |
| rev-06 | tests/backup-verify.test.js + tests/rel14-backup-bytes.test.js | PASS |

No breakage from the main movement `a436d0cac` → `6e03ee51e` on any tested script.

## 2. Adversarial commit review (rev-07..10)

### rev-07: `16604aa3f` — ci(invariants): wire the invariant harness as a standalone CI gate (new `scripts/invariants-ci.mjs`, 262 lines)
- Affected suite: `tests/invariants-ci-parser.test.js` → PASS.
- Review: new standalone gate script; parser unit-tested. No logic concerns
  found on read; the script is additive (new file, no existing behavior changed).

### rev-08: `feed63746` — Compare-and-release: bind POST work-claims/:id/release to the claim round (E5/D4) (`scripts/agent-inbox.mjs` +10/-1)
- Affected suites: agent-autonomy-client, agent-connection, agent-doctor, agent-identities → all PASS.
- **VERDICT: BROKEN — see BUG-3.** The commit reads the claim and passes
  `expectedClaimedAt`/`expectedHistoryLength` to `client.workRelease`, but
  `client/room-agent.mjs:878` destructures only `{note, reason, signal}` and
  drops the round fields before HTTP (proven: sent body is `{"note":"n"}`).
  The claimed E5/D4 binding is not delivered on this path. Fail-first test:
  `tests/work-release-round-binding.test.js` ("SDK workRelease sends the round
  preconditions on the wire").

### rev-09: `1db3e71f1` — Browser checks: snapshot routes match the path, so stream-open re-reads are caught (`scripts/stream-recovery-browser-check.mjs` +4/-1)
- No unit-test references (browser check); diff reviewed by read.
- **VERDICT: sound.** Tightens the check so stream-open re-reads are caught by
  matching snapshot routes to the path. No logic concerns; additive assertion
  strength only.

### rev-10: `6146ae702` — Compare-and-release: bind POST work-claims/:id/release to the claim round (E5/D4) (`scripts/qa3/authz-board.mjs` +13/-4)
- No unit-test references (qa3 harness); diff reviewed by read.
- **VERDICT: BROKEN — see BUG-3.** Unlike agent-inbox.mjs, this harness sends
  the round fields via raw `client.request` POST, so they DO reach the server —
  where the release route's strict body shape (`{note?, reason?}`,
  `server/work-claim-routes.mjs:1201`) rejects them with **422
  invalid_claim_input**. The "release claim" action in this harness is broken
  outright (proven end-to-end: 422 with fields, 200 without). Moreover the
  release route performs no round comparison at all, so even a correct client
  could not get round-binding today. Fail-first tests:
  `tests/work-release-round-binding.test.js` (stale→409, fresh→200).

## 3. BUG-3 summary (posted to muse-room, 3rd of 3 today)

**BUG CONFIRMED: scripts/agent-inbox.mjs:513** — E5/D4 round-binding on
work-release is a no-op two ways: (1) client `workRelease`/`releaseWorkItem`
drops the round fields before HTTP; (2) POST /release accepts only
`{note?, reason?}` and has no round comparison, so the fields 422 when sent —
which also breaks `scripts/qa3/authz-board.mjs`'s release action outright.
Repro: scratch server + claim; `POST /release` with
`{expectedClaimedAt, expectedHistoryLength}` → 422 (not 409); without → 200
(unbound). Fail-first: `tests/work-release-round-binding.test.js` (3 failing
assertions). Fix needs `client/room-agent.mjs` (pass-through) +
`server/work-claim-routes.mjs` (accept + compare on release) — outside this
guild's slice; flagged for the owning lane.

## Raw logs

`findings/guild-06/logs/rev-{01..10}.result`; per-commit diffs in
`rev-{07..10}.log.commit-diff.txt`; suite outputs in `rev-{01..06}.log.suite-*.out`.
