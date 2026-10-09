# Chaos seed corpus — PRODUCT-200 reliability

Deterministic regression seeds encoding QA-200's confirmed failure sequences.
Each seed is an exact op sequence plus the property it must satisfy, executed
against the real implementation. Standalone: shaped to plug into the chaos
harness frame when it lands (each seed is `{ id, title, finding, expect, run }`).

## The XFAIL protocol

`seed.expect` is the expected outcome on today's code:

- `expect: "fail"` — the seed FAILS for the intended reason: the bug
  reproduces on this code. The runner asserts the failure happens, so the
  suite stays green while machine-proving the bug is still present.
- `expect: "pass"` — the property holds; any violation is a regression.

When a fix lands, a `"fail"` seed unexpectedly passes and the runner fails
loudly — flip `expect` to `"pass"` and the seed becomes a permanent guard.
Never "fix" the suite by weakening a seed's property.

## Seeds

### SEED-E5 — stale-release replay must not destroy a fresh claim round
- **Finding:** QA-200 failseq E5/D4 (RANKED-FINDINGS.md §1–2). `POST
  /rooms/{room}/work-claims/{id}/release` checks owner-only; no round token.
- **Ops:** create → claim (round 1) → release (round 1) → claim (round 2) →
  replay the stale round-1 release payload (`{}` — the exact shape a client
  holds after a timeout) → read back.
- **Property:** the round-2 claim is untouched: state `claimed`, owner
  unchanged, same `claimedAt`, same history length. History length is the
  true round counter (a same-millisecond re-claim keeps the old `claimedAt`).
- **Today:** FAILS — the stale replay returns 200 and destroys round 2.
- **Fix:** PR #2088 (compare-and-release: `expectedClaimedAt` +
  `expectedHistoryLength`; stale → 409 `work_claim_conflict`). The seed's
  bare-`{}` replay 422s/409s on fixed code — forward-compatible, no change needed.

### SEED-A3 — byte-identical update retry must not append a duplicate history entry
- **Finding:** QA-200 invariants inv-s7-r2 BUG-2. The update route has no
  requestId; `withHistory()` stamps unconditionally — a retried update after a
  simulated timeout permanently inflates the lifetime history count. (John's
  QA-plan invariant 1: retry must not duplicate work.)
- **Ops:** create → claim → update `{note}` → (timeout, response lost) →
  retry the IDENTICAL update → read back.
- **Property:** history length is unchanged by the retry.
- **Today:** FAILS — history grows 3 → 4.
- **Fix sketch (from the finding):** requestId idempotency per
  claim+requestId, or a byte-identical no-change guard. The seed retries
  byte-identical with no requestId field (none exists on the route today); a
  requestId-only fix must treat a byte-identical retry as the same request,
  otherwise extend the seed with a requestId-bearing variant.

### SEED-B24 — every committed board write must journal a work_claim.* event
- **Finding:** QA-200 invariants inv-b24 (P1). The board write path emits no
  events: 391 claims / 1035 history transitions, zero `work_claim.*` events in
  the room log. Event-replay board reconstruction is impossible; event-based
  monitors are blind to all board activity.
- **Ops:** create → claim → note-only update → release → inspect the journal.
- **Property:** the journal holds `work_claim.created`, `work_claim.claimed`,
  `work_claim.updated`, `work_claim.released` in order, each carrying
  `{ claimId, revision }` (revision = history length at commit).
- **Today:** FAILS — the journal is empty.
- **Seam contract:** the seed's world exposes `store.journalClaimEvent(type,
  data)` as the sink. The fix wires the board write path to journal through
  the room's real event log; keep the sink's shape (`{type, claimId,
  revision, state, owner}`) when wiring it. **Retirement condition:** if the
  owner instead documents the board as explicitly non-event-sourced (the
  finding's alternative fix), retire this seed and replace it with a seed
  asserting the documented contract.

### SEED-G1 — invite-redeem retry must recover the membership or name a recovery path
- **Finding:** QA-200 failseq G1 (candidate, deferred to owner). Redeem
  commits the membership burn; the 201 body is lost on timeout. The identity
  secret is shown exactly once — if the body is lost, the retry gets a bare
  409 `invite_already_used` with no recovery path (security-adjacent:
  stranded membership).
- **Ops:** create code → redeem (commits; body "lost") →
  (a) retry WITH the retained secret → (b) retry WITHOUT the secret →
  (c) separate code, double-redeem.
- **Property:** (a) re-attaches with `duplicate:true` (holds today —
  regression guard); (b) the secret-less retry offers a recovery path: it
  either re-attaches or fails with a recovery handle (a `recovery`/`next`
  payload or a code distinct from bare `invite_already_used`); (c)
  double-redeem is exactly-once (holds today — regression guard).
- **Today:** FAILS on (b) — bare 409, no recovery path.

## Model-based differential tester

`claim-lifecycle-model.mjs` is an independent state-machine model of the
claim lifecycle (written from the documented contract, not the code).
`claim-lifecycle-model.test.js` drives the model and the real implementation
(route handler + pure functions under a virtual clock) over the same
deterministic random op sequences and compares after every op.

Known divergence signatures: `E5:stale-release-accepted`,
`A3:retry-appended-history`, `B24:no-board-events` — the seed bugs,
reproduced independently. The test requires each known signature to appear
and no unknown signature to appear. Scale: `CHAOS_MODEL_SEQUENCES` (default
150), `CHAOS_MODEL_OPS` (default 20), `CHAOS_MODEL_SEED` (default 20261008).

## Adding a seed

1. Confirm the failure sequence against QA findings (sequence, not clicks).
2. Encode the exact ops + the property in `seeds.mjs`; set `expect: "fail"`
   and verify it fails for the intended reason (check the evidence string).
3. Document it here. Drive the real implementation — no reimplementation,
   no production seams.

## CI

`.github/workflows/chaos-seeds.yml`: per-PR smoke runs `chaos-seeds.test.js`
only (deterministic seeds, seconds); the nightly full run executes both test
files with extended model sequences.
