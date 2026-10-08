// QA-200 adversarial challenge ch-1951 against PR #1951 ("pr_merged refuses a
// never-funded (offered) escrow").
//
// #1951 closed the "offered" door by checking the status FLAG. These tests
// show the funding concept itself was still label-only:
//
//   A.  "locked" is a phantom status — no transition in this module ever
//       produces it — yet #1951's guard admitted it to the pr_merged release
//       path (and seatEvaluation admitted it too). A record stamped "locked"
//       with zero funding provenance released the full split: the same
//       mint-from-nothing #1951 closed for "offered".
//   B.  pr_merged paid the provider leg to `item.owner` without checking the
//       funder pinned by lockEscrowOnClaim (escrow.fundedBy). A lease that
//       moved between funding and settlement misdirected the payout.
//   C.  "funded" was a label: a record stamped status:"funded" with no
//       fundedBy/fundedAt (never through lockEscrowOnClaim) still settled.
//   D.  seatEvaluation never re-verified the lease: a funded escrow on a
//       lapsed (unclaimed) or moved lease could still be seated and driven
//       to release.
//
// Fail-first: every refusal test below failed on the pre-challenge code
// ("Missing expected exception" / wrong code); all pass after the fix, and
// the full lifecycle still releases to the funder.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EscrowError,
  settleEscrowFromPull,
  offerEscrow,
  lockEscrowOnClaim,
  seatEvaluation,
  verdictGate,
} from "../server/claim-escrow-adapter.mjs";

const NOW = Date.parse("2026-10-08T07:30:00.000Z");
const throwsCode = (fn, code) =>
  assert.throws(fn, error => error instanceof EscrowError && error.code === code);

const baseEscrow = over => Object.freeze({ status: "funded", budgetUnits: 1000,
  evaluatorCount: 2, evaluatorFeeBps: 100, platformFeeBps: 100,
  offeredAt: "2026-10-08T06:00:00.000Z", offeredBy: "quill", expiresInMs: null, ...over });

// A. The phantom "locked" status: never produced by any transition, yet the
// #1951 guard let it release the full split with zero funding provenance.
test("pr_merged refuses a never-produced 'locked' escrow (no funding provenance)", () => {
  const phantom = { id: "w-phantom", state: "done", owner: "mallory",
    escrow: baseEscrow({ status: "locked" }) };
  throwsCode(
    () => settleEscrowFromPull({ action: "pr_merged", item: phantom }, { now: NOW }),
    "escrow_not_funded",
  );
});

test("seatEvaluation refuses the phantom 'locked' status", () => {
  const phantom = { id: "w-phantom", state: "claimed", owner: "mallory",
    escrow: baseEscrow({ status: "locked" }) };
  throwsCode(() => seatEvaluation(phantom, "round-1", { now: NOW }), "escrow_not_active");
});

// B. Release binds the funder: the provider leg must go to escrow.fundedBy,
// not to whoever holds the claim at settle time.
test("pr_merged refuses when the lease moved since funding (owner !== fundedBy)", () => {
  const { item: offered } = offerEscrow(
    { id: "w-moved", state: "unclaimed", owner: null },
    { budgetUnits: 1000, evaluatorCount: 2 }, { actorId: "quill", now: NOW });
  const { item: funded } = lockEscrowOnClaim(
    { ...offered, state: "claimed", owner: "w1" }, "w1", { now: NOW });
  assert.equal(funded.escrow.fundedBy, "w1");
  const moved = { ...funded, state: "done", owner: "w2" };
  throwsCode(
    () => settleEscrowFromPull({ action: "pr_merged", item: moved }, { now: NOW }),
    "escrow_funder_mismatch",
  );
});

// C. "funded" requires lock-path provenance, not just the status flag.
test("pr_merged refuses a 'funded' record with no funding provenance", () => {
  const stamped = { id: "w-stamped", state: "done", owner: "mallory",
    escrow: baseEscrow({ status: "funded" }) }; // no fundedAt / fundedBy
  throwsCode(
    () => settleEscrowFromPull({ action: "pr_merged", item: stamped }, { now: NOW }),
    "escrow_not_funded",
  );
});

// D. seatEvaluation re-verifies the lease: lapsed or moved leases fail closed.
test("seatEvaluation refuses when the lease lapsed (claim no longer claimed)", () => {
  const { item: offered } = offerEscrow(
    { id: "w-lapsed", state: "unclaimed", owner: null },
    { budgetUnits: 1000, evaluatorCount: 2 }, { actorId: "quill", now: NOW });
  const { item: funded } = lockEscrowOnClaim(
    { ...offered, state: "claimed", owner: "w1" }, "w1", { now: NOW });
  const lapsed = { ...funded, state: "unclaimed", owner: null };
  throwsCode(() => seatEvaluation(lapsed, "round-1", { now: NOW }), "invalid_escrow_input");
});

test("seatEvaluation refuses when the funder no longer holds the lease", () => {
  const { item: offered } = offerEscrow(
    { id: "w-moved2", state: "unclaimed", owner: null },
    { budgetUnits: 1000, evaluatorCount: 2 }, { actorId: "quill", now: NOW });
  const { item: funded } = lockEscrowOnClaim(
    { ...offered, state: "claimed", owner: "w1" }, "w1", { now: NOW });
  const moved = { ...funded, owner: "w2" };
  throwsCode(() => seatEvaluation(moved, "round-1", { now: NOW }), "escrow_not_owner");
});

// The happy path still works end to end: offer -> fund -> seat -> verdict ->
// pr_merged releases the exact split to the funder.
test("full lifecycle still releases to the funder after the challenge fix", () => {
  const { item: offered } = offerEscrow(
    { id: "w-happy", state: "unclaimed", owner: null },
    { budgetUnits: 1000, evaluatorCount: 2 }, { actorId: "quill", now: NOW });
  const { item: funded } = lockEscrowOnClaim(
    { ...offered, state: "claimed", owner: "w1" }, "w1", { now: NOW });
  const { item: seated } = seatEvaluation(funded, "round-9", { now: NOW });
  assert.equal(seated.escrow.status, "evaluating");
  assert.equal(verdictGate(seated, { approvals: 2, quorum: 2, roundId: "round-9" }), true);
  const out = settleEscrowFromPull(
    { action: "pr_merged", item: { ...seated, state: "done" } }, { now: NOW });
  assert.equal(out.item.escrow.status, "released");
  const { provider, evaluator, platform } = out.item.escrow.split;
  assert.equal(provider + evaluator + platform, 1000);
  assert.equal(out.journal[0].kind, "escrow_released_provider");
  assert.equal(out.journal[0].actor, "w1", "provider leg pays the funder");
});

// pr_closed stays permissive in the safe direction: refunding a "locked"
// record returns the encumbrance to the client — money moves back, nothing
// is minted.
test("pr_closed still refunds a 'locked' record (safe direction unchanged)", () => {
  const phantom = { id: "w-phantom", state: "unclaimed", owner: null,
    escrow: baseEscrow({ status: "locked" }) };
  const out = settleEscrowFromPull({ action: "pr_closed", item: phantom }, { now: NOW });
  assert.equal(out.item.escrow.status, "refunded");
  assert.equal(out.journal[0].kind, "escrow_refunded");
});
