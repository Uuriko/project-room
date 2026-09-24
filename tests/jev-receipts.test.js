// Jev-harness receipt-acceptance gate: pure scorer tests (docs/JEV-GATES.md).
//
// Fixtures: artifact-linked vs bare claims, verdict mapping, the
// low-confidence-accept escalate flag. Also asserts shadow semantics
// (enforced:false) and frozen/deterministic output.
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReceipt,
  jevReceiptAcceptThreshold,
  jevReceiptRequestChangesThreshold,
  jevReceiptHighConfidence,
  jevReceiptWeights,
  JevError,
} from "../server/jev-receipts.mjs";

const base = (overrides = {}) => ({
  workId: "work-1",
  at: 1_700_000_000_000,
  ...overrides,
});

test("artifact-linked receipt with attestation accepts at high confidence", () => {
  const decision = evaluateReceipt(base({
    reviewPolicy: "independent_principal",
    attestations: [{ memberId: "m1" }, { memberId: "m2" }],
    reviewerIsVerifier: true,
    note: "Shipped in PR #826 — merged https://github.com/Uuriko/project-room/pull/826",
    claimedAtMs: 1_700_000_000_000 - 3_600_000,
    doneAtMs: 1_700_000_000_000,
  }));
  assert.equal(decision.verdict, "accept");
  assert.equal(decision.escalate, false);
  assert.ok(decision.quality >= jevReceiptHighConfidence, `quality ${decision.quality}`);
  assert.equal(decision.enforced, false);
});

test("bare claim with no evidence escalates", () => {
  const decision = evaluateReceipt(base({
    reviewPolicy: "self_attested",
    note: "done",
    claimedAtMs: 1_700_000_000_000 - 30_000,
    doneAtMs: 1_700_000_000_000,
  }));
  assert.ok(decision.quality < jevReceiptRequestChangesThreshold, `quality ${decision.quality}`);
  assert.equal(decision.verdict, "escalate");
  assert.equal(decision.escalate, true);
  const evidence = decision.signals.find(s => s.key === "evidence");
  assert.ok(evidence.value <= 0.1, evidence.detail);
});

test("commit SHA in the note counts as an artifact reference", () => {
  const decision = evaluateReceipt(base({ note: "done in 3b72d7d1", claimedAtMs: 1_700_000_000_000 - 600_000, doneAtMs: 1_700_000_000_000 }));
  const evidence = decision.signals.find(s => s.key === "evidence");
  assert.equal(evidence.value, 1);
});

test("mid-quality receipt lands on request-changes", () => {
  const decision = evaluateReceipt(base({
    reviewPolicy: "self_attested",
    note: "Implemented the change and ran the checks locally; nothing else to show.",
    claimedAtMs: 1_700_000_000_000 - 600_000,
    doneAtMs: 1_700_000_000_000,
  }));
  assert.ok(decision.quality >= jevReceiptRequestChangesThreshold && decision.quality < jevReceiptAcceptThreshold,
    `quality ${decision.quality}`);
  assert.equal(decision.verdict, "request-changes");
});

test("low-confidence accept is flagged for a human look", () => {
  // Just over the accept line but thin on policy strength: still accepted
  // (shadow), but escalate:true. Math: 0.4*1 + 0.3*0.35 + 0.15*1 + 0.15*0.8
  // = 0.775 — accept, but under 0.85.
  const decision = evaluateReceipt(base({
    reviewPolicy: "self_attested",
    attestations: [{ memberId: "m1" }],
    note: "Shipped — merged PR #12.",
    claimedAtMs: 1_700_000_000_000 - 900_000,
    doneAtMs: 1_700_000_000_000,
  }));
  assert.equal(decision.verdict, "accept");
  assert.ok(decision.quality >= jevReceiptAcceptThreshold, `quality ${decision.quality}`);
  assert.ok(decision.quality < jevReceiptHighConfidence, `quality ${decision.quality}`);
  assert.equal(decision.escalate, true);
  assert.equal(decision.enforced, false); // shadow: accepted anyway
});

test("instant completion tanks durationSanity", () => {
  const decision = evaluateReceipt(base({
    claimedAtMs: 1_700_000_000_000 - 10_000,
    doneAtMs: 1_700_000_000_000,
  }));
  const duration = decision.signals.find(s => s.key === "durationSanity");
  assert.ok(duration.value <= 0.15, duration.detail);
});

test("stronger review policies score higher, all else equal", () => {
  const scored = policy => evaluateReceipt(base({ reviewPolicy: policy, attestations: [{ memberId: "m1" }] })).quality;
  assert.ok(scored("independent_principal") > scored("distinct_member"));
  assert.ok(scored("distinct_member") > scored("self_attested"));
});

test("thresholds match the documented legend", () => {
  assert.equal(jevReceiptAcceptThreshold, 0.7);
  assert.equal(jevReceiptRequestChangesThreshold, 0.4);
  assert.equal(jevReceiptHighConfidence, 0.85);
  const sum = Object.values(jevReceiptWeights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("output is frozen and deterministic", () => {
  const input = base({ note: "did the thing", reviewPolicy: "self_attested" });
  const a = evaluateReceipt(input), b = evaluateReceipt(input);
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.signals));
});

test("verdict vocabulary is exactly accept|request-changes|escalate", () => {
  for (const overrides of [
    {},
    { note: "x".repeat(100), reviewPolicy: "distinct_member", attestations: [{ memberId: "m1" }] },
    { note: "merged PR #1 https://github.com/a/b/pull/1", reviewPolicy: "independent_principal",
      attestations: [{ memberId: "m1" }, { memberId: "m2" }], reviewerIsVerifier: true,
      claimedAtMs: 1_700_000_000_000 - 3_600_000, doneAtMs: 1_700_000_000_000 },
  ]) {
    const verdict = evaluateReceipt(base(overrides)).verdict;
    assert.ok(["accept", "request-changes", "escalate"].includes(verdict), verdict);
  }
});

test("invalid inputs fail with coded errors", () => {
  assert.throws(() => evaluateReceipt(base({ workId: "" })), err => err instanceof JevError && err.code === "invalid_receipt_input");
  assert.throws(() => evaluateReceipt(base({ reviewerIsVerifier: "yes" })), JevError);
  assert.throws(() => evaluateReceipt(base({ note: 42 })), JevError);
});
