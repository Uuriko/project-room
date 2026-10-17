// #3546/#3547: the delivered -> verified claim lifecycle. Pure state-machine
// tests; route tests own transport and the review-policy HTTP gates.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWork, claimWork, updateWork, recordReview, recordCi, canCloseWork,
  releaseExpired, workOf, deliveryDigest, ClaimError,
} from "../server/work-claims.mjs";

const SHA = "a".repeat(64);
const HEAD = "b".repeat(40);
const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);
const bundle = (over = {}) => ({
  artifact: { kind: "text", ref: "room://artifacts/1", sha256: SHA },
  checks: [{ name: "unit", result: "pass" }],
  criteria: [],
  ...over,
});
const start = (item, owner = "quill") => updateWork(claimWork(item, owner), owner, { state: "in_progress" });
const reviewedItem = (over = {}) => start(createWork({ id: "w1", reviewPolicy: "distinct_member", ...over }, { agentId: "quill" }));

test("reviewed policy: done from in_progress is refused — the work must be delivered first", () => {
  const active = reviewedItem();
  throwsCode(() => updateWork(active, "quill", { state: "done", delivery: bundle() }), "work_not_delivered");
  assert.equal(active.state, "in_progress");
});

test("reviewed policy: finish occupies delivered with the frozen bundle, verify completes it", () => {
  const active = reviewedItem();
  const delivered = updateWork(active, "quill", { state: "delivered", delivery: bundle(), deliveryMode: "result" });
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.delivery.digest, deliveryDigest(bundle()));
  assert.equal(delivered.delivery.deliveredBy, "quill");
  assert.equal(delivered.verification, null);
  // The reviewer reviews the delivery itself, then verifies from their own call.
  const reviewed = recordReview(delivered, "sage", { verdict: "approve", summary: "bundle checks out" });
  assert.equal(canCloseWork(reviewed, "sage", { policy: "distinct_member", reviewMembers: ["sage"] }), true);
  const done = updateWork(reviewed, "sage", { state: "done", reviewedBy: "sage", authority: true });
  assert.equal(done.state, "done");
  assert.equal(done.verification.state, "verified");
  assert.equal(done.verification.by, "sage");
  assert.equal(done.verification.basis.owner, "quill");
  assert.deepEqual(done.verification.executedChecks.map(entry => [entry.name, entry.result]),
    [["bundle_integrity", "pass"]]);
});

test("verify-by-owner is refused by the policy gate", () => {
  const delivered = updateWork(reviewedItem(), "quill", { state: "delivered", delivery: bundle() });
  assert.equal(canCloseWork(delivered, "quill", { policy: "distinct_member", reviewMembers: ["quill", "sage"] }), false);
});

test("changes_requested sends delivered work back to in_progress and records the fact", () => {
  const delivered = updateWork(reviewedItem(), "quill", { state: "delivered", delivery: bundle() });
  const reviewed = recordReview(delivered, "sage", { verdict: "changes_requested", summary: "criterion 2 is not met" });
  const back = updateWork(reviewed, "sage", { state: "in_progress", authority: true });
  assert.equal(back.state, "in_progress");
  assert.equal(back.verification.state, "changes_requested");
  assert.equal(back.verification.by, "sage");
  assert.equal(back.delivery.digest, delivered.delivery.digest);
  // A fresh finish clears the send-back fact and awaits a new verdict.
  const redelivered = updateWork(back, "quill", { state: "delivered", delivery: bundle() });
  assert.equal(redelivered.verification, null);
});

test("self_attested: a single done call collapses finish+verify but records self-attestation", () => {
  const active = start(createWork({ id: "w2" }, { agentId: "quill" }));
  const done = updateWork(active, "quill", { state: "done", delivery: bundle(), note: "shipped" });
  assert.equal(done.state, "done");
  assert.equal(done.verification.state, "self_attested");
  assert.equal(done.verification.by, "quill");
  assert.equal(done.delivery.digest, deliveryDigest(bundle()));
  assert.deepEqual(done.verification.executedChecks.map(entry => [entry.name, entry.result]),
    [["bundle_integrity", "pass"]]);
});

test("self_attested: a criteria-less claim still finishes with a note alone, bundle recorded absent", () => {
  const active = start(createWork({ id: "w3" }, { agentId: "quill" }));
  const done = updateWork(active, "quill", { state: "done", note: "done it" });
  assert.equal(done.state, "done");
  assert.equal(done.delivery, null);
  assert.equal(done.verification.state, "self_attested");
  assert.deepEqual(done.verification.executedChecks, []);
});

test("bundle contract: each missing part is refused by name", () => {
  const criteriaItem = () => start(createWork(
    { id: "w4", reviewPolicy: "distinct_member", acceptanceCriteria: ["docs updated", "tests green"] }, { agentId: "quill" }));
  // No bundle at all under a reviewed policy.
  assert.throws(() => updateWork(criteriaItem(), "quill", { state: "delivered" }),
    error => error.code === "delivery_incomplete" && /requires a delivery bundle/.test(error.message));
  // Missing artifact.
  assert.throws(() => updateWork(criteriaItem(), "quill", { state: "delivered",
    delivery: { checks: [{ name: "unit", result: "pass" }], criteria: [] } }),
    error => error.code === "delivery_incomplete" && /missing its artifact/.test(error.message));
  // Missing checks.
  assert.throws(() => updateWork(criteriaItem(), "quill", { state: "delivered",
    delivery: { artifact: { kind: "text", ref: "room://a", sha256: SHA }, checks: [], criteria: [] } }),
    error => error.code === "delivery_incomplete" && /missing checks/.test(error.message));
  // Criteria mapping does not cover every criterion.
  assert.throws(() => updateWork(criteriaItem(), "quill", { state: "delivered",
    delivery: bundle({ criteria: [{ criterion: "docs updated", status: "met" }] }) }),
    error => error.code === "delivery_incomplete" && /"tests green"/.test(error.message));
  // A caller-reported failing check cannot ride into verification.
  assert.throws(() => updateWork(criteriaItem(), "quill", { state: "delivered",
    delivery: bundle({ checks: [{ name: "unit", result: "fail" }],
      criteria: [{ criterion: "docs updated", status: "met" }, { criterion: "tests green", status: "met" }] }) }),
    error => error.code === "delivery_incomplete" && /failing check "unit"/.test(error.message));
  // The complete bundle finishes.
  const delivered = updateWork(criteriaItem(), "quill", { state: "delivered",
    delivery: bundle({ criteria: [{ criterion: "docs updated", status: "met" }, { criterion: "tests green", status: "met" }] }) });
  assert.equal(delivered.state, "delivered");
  assert.deepEqual(delivered.acceptanceCriteria, ["docs updated", "tests green"]);
});

test("executed checks: a tampered stored bundle fails bundle_integrity and blocks the verify", () => {
  const delivered = updateWork(reviewedItem(), "quill", { state: "delivered", delivery: bundle() });
  const reviewed = recordReview(delivered, "sage", { verdict: "approve", summary: "ok" });
  const tampered = { ...reviewed, delivery: { ...reviewed.delivery,
    checks: [...reviewed.delivery.checks, { name: "extra", result: "pass" }] } };
  throwsCode(() => updateWork(tampered, "sage", { state: "done", reviewedBy: "sage", authority: true }), "delivery_check_failed");
});

test("executed checks: platform-settled CI failure blocks a reviewed verify; success is recorded", () => {
  const withCi = state => {
    const active = reviewedItem();
    const settled = recordCi(active, { state, headSha: HEAD, url: null }).item;
    return updateWork(settled, "quill", { state: "delivered", delivery: bundle() });
  };
  const failed = recordReview(withCi("failure"), "sage", { verdict: "approve", summary: "ok" });
  assert.throws(() => updateWork(failed, "sage", { state: "done", reviewedBy: "sage", authority: true }),
    error => error.code === "delivery_check_failed" && /ci_settlement/.test(error.message));
  const passed = recordReview(withCi("success"), "sage", { verdict: "approve", summary: "ok" });
  const done = updateWork(passed, "sage", { state: "done", reviewedBy: "sage", authority: true });
  assert.deepEqual(done.verification.executedChecks.map(entry => [entry.name, entry.result]),
    [["bundle_integrity", "pass"], ["ci_settlement", "pass"]]);
});

test("independent_principal: the verify gate also requires the verify permission set", () => {
  const delivered = updateWork(
    start(createWork({ id: "w5", reviewPolicy: "independent_principal" }, { agentId: "quill" })),
    "quill", { state: "delivered", delivery: bundle() });
  const reviewed = recordReview(delivered, "sage", { verdict: "approve", summary: "ok" });
  assert.equal(canCloseWork(reviewed, "sage", { policy: "independent_principal", reviewMembers: ["sage"] }), false);
  assert.equal(canCloseWork(reviewed, "sage",
    { policy: "independent_principal", reviewMembers: ["sage"], verifyMembers: new Set(["sage"]) }), true);
});

test("delivered work is never lease-swept back to unclaimed", () => {
  const claimed = claimWork(createWork({ id: "w6" }, { agentId: "quill", now: 0 }), "quill", { leaseHours: 1, now: 0 });
  const active = updateWork(claimed, "quill", { state: "in_progress", now: 1000 });
  const delivered = updateWork(active, "quill", { state: "delivered", delivery: bundle(), now: 2000 });
  const swept = releaseExpired([delivered], Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(swept[0].state, "delivered");
});

test("delivery and verification survive the stored-row round trip", () => {
  const delivered = updateWork(reviewedItem(), "quill", { state: "delivered", delivery: bundle() });
  const revived = workOf(JSON.parse(JSON.stringify(delivered)));
  assert.deepEqual(revived.delivery, delivered.delivery);
  assert.equal(revived.verification, null);
  const done = updateWork(recordReview(revived, "sage", { verdict: "approve", summary: "ok" }),
    "sage", { state: "done", reviewedBy: "sage", authority: true });
  const revivedDone = workOf(JSON.parse(JSON.stringify(done)));
  assert.deepEqual(revivedDone.verification, done.verification);
  assert.deepEqual(revivedDone.delivery, done.delivery);
});
