// #3546/#3547: the delivered -> verified claim lifecycle. Pure state-machine
// tests; route tests own transport and the review-policy HTTP gates.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWork, claimWork, updateWork, recordReview, recordCi, canCloseWork,
  releaseExpired, reassignWork, workOf, deliveryDigest, executeDeliveryChecks, ClaimError,
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

// Mutation-testing lane 2026-10-16 (B1): the bundle-required condition is
// an OR of two legs — criteria-bearing OR reviewed-policy. The contract
// test above exercises both legs at once (distinct_member WITH criteria),
// which masks the loss of either leg alone. These two pins cover the
// single-leg combinations.

test("bundle contract: a reviewed claim needs a bundle even without acceptance criteria", () => {
  // Kills WC-04 (bundle-required drops the policy leg).
  const item = start(createWork({ id: "w-mut-1", reviewPolicy: "distinct_member" }, { agentId: "quill" }));
  assert.throws(() => updateWork(item, "quill", { state: "delivered" }),
    error => error.code === "delivery_incomplete" && /requires a delivery bundle/.test(error.message));
});

test("verify: a delivery that declares its own criterion not_met fails coverage", () => {
  // Kills WC-10 (criteria_coverage ignores not_met mappings, #3683). The
  // finish-time contract checks that every criterion is MAPPED; the
  // mapping's own verdict is read here, at verify time — a delivery that
  // says "not_met" about itself must not verify.
  const item = start(createWork(
    { id: "w-mut-3", reviewPolicy: "distinct_member", acceptanceCriteria: ["tests green"] }, { agentId: "quill" }));
  const delivered = updateWork(item, "quill", { state: "delivered",
    delivery: bundle({ criteria: [{ criterion: "tests green", status: "not_met" }] }) });
  assert.equal(delivered.state, "delivered");
  // #3613: the reviewer's own outcome may (wrongly) say pass — the platform
  // coverage check still reads the delivery's declared not_met and blocks.
  const reviewed = recordReview(delivered, "sage", { verdict: "approve", summary: "looks fine at a glance",
    criterionOutcomes: [{ criterionId: "c1", verdict: "pass" }] });
  assert.throws(() => updateWork(reviewed, "sage", { state: "done", reviewedBy: "sage", authority: true }),
    error => error.code === "delivery_check_failed" && /criteria_coverage/.test(error.message));
});

test("executed checks: CI settled against a different delivery fails closed", () => {
  // Kills WC-11 (ci_settlement delivery binding removed, #3685 second
  // lock). Re-delivery clears the CI record outright; this lock is for the
  // stored row whose CI stamp names an earlier round's delivery — the
  // settlement must not count for the delivery now on the claim.
  const item = start(createWork({ id: "w-mut-4", reviewPolicy: "distinct_member" }, { agentId: "quill" }));
  const delivered = updateWork(item, "quill", { state: "delivered", delivery: bundle() });
  const settled = recordCi(delivered, { state: "success", headSha: HEAD }, Date.now()).item;
  const bound = executeDeliveryChecks(settled).find(entry => entry.name === "ci_settlement");
  assert.equal(bound.result, "pass"); // control: stamped for THIS delivery
  const stale = { ...settled, ci: { ...settled.ci, deliveryDigest: "0".repeat(64) } };
  const unbound = executeDeliveryChecks(stale).find(entry => entry.name === "ci_settlement");
  assert.equal(unbound.result, "fail");
  assert.match(unbound.detail, /different delivery/);
});

test("round clearing: a manual release drops the whole round — delivery, verification, reviews, CI", () => {
  // Kills WC-12/WC-13/WC-14/WC-15 (one clearing field each removed from
  // updateWork's release). This is the claims-F1 shape: whatever the
  // release keeps, the next claimer inherits — a frozen bundle stamped
  // with the previous owner's name, a stale verification fact, the last
  // round's reviews, or a CI settlement for work they have not done.
  const active = start(createWork({ id: "w-mut-5", reviewPolicy: "distinct_member" }, { agentId: "quill" }));
  const delivered = updateWork(active, "quill", { state: "delivered", delivery: bundle() });
  const settled = recordCi(delivered, { state: "success", headSha: HEAD }, Date.now()).item;
  const sentBack = recordReview(settled, "sage", { verdict: "changes_requested", summary: "redo the artifact" });
  const back = updateWork(sentBack, "sage", { state: "in_progress", authority: true });
  assert.ok(back.delivery && back.verification && back.reviews.length === 1 && back.ci);
  const paused = updateWork(back, "quill", { state: "claimed" }); // pause keeps the round; release drops it
  const released = updateWork(paused, "quill", { state: "unclaimed" });
  assert.equal(released.state, "unclaimed");
  assert.equal(released.owner, null);
  assert.equal(released.delivery, null);
  assert.equal(released.verification, null);
  assert.deepEqual(released.reviews, []);
  assert.equal(released.ci, null);
});

test("round clearing: the lease sweep drops the lapsed round — files, reviews, attestations, CI", () => {
  // Kills WC-16/WC-17/WC-18 (one clearing field each removed from
  // releaseExpired). Same inheritance hazard as the manual release, on
  // the path nobody performs by hand.
  const T0 = Date.parse("2026-10-16T00:00:00.000Z");
  let item = claimWork(createWork({ id: "w-mut-6" }, { now: T0, agentId: "quill" }), "quill",
    { now: T0, leaseHours: 1, files: ["src/a.js"] });
  item = updateWork(item, "quill", { state: "in_progress", now: T0 });
  item = recordReview(item, "sage", { verdict: "approve", summary: "early look ok", now: T0 });
  item = recordCi(item, { state: "success", headSha: HEAD }, T0).item;
  assert.ok(item.files.length === 1 && item.reviews.length === 1 && item.attestations.length >= 1 && item.ci);
  const [released] = releaseExpired([item], T0 + 2 * 3_600_000);
  assert.equal(released.state, "unclaimed");
  assert.equal(released.owner, null);
  assert.deepEqual(released.files, []);
  assert.deepEqual(released.reviews, []);
  assert.deepEqual(released.attestations, []);
  assert.equal(released.ci, null);
});

test("reassign: a delivered claim reopens in_progress — delivery retained, no verdict stands", () => {
  // Adjudication (MUTATION-CI-FIX): WC-21/WC-22's pin asserted the
  // pre-#3867 contract — reassignWork cleared delivery + verification on
  // every reassign. #3867 (claims bundle lifecycle, findings-05 F2)
  // replaced that reset with branch-specific round handling, so the old
  // assertion now contradicts the landed contract and is retired; the
  // three tests here pin the new contract branch by branch instead.
  // This branch is the F2 fix itself: a delivered claim used to keep its
  // delivered state with the bundle nulled, stranding it for a zero-check
  // verify; now it reopens to in_progress with the bundle intact, so the
  // delivery must go through review again under the new owner.
  const active = start(createWork({ id: "w-mut-7", reviewPolicy: "distinct_member" }, { agentId: "quill" }));
  const delivered = updateWork(active, "quill", { state: "delivered", delivery: bundle() });
  const reopened = reassignWork(delivered, "lead", "instinct", { authority: true });
  assert.equal(reopened.owner, "instinct");
  assert.equal(reopened.state, "in_progress");
  assert.equal(reopened.delivery.digest, delivered.delivery.digest);
  assert.equal(reopened.verification, null);
  assert.equal(reopened.deliveryGeneration, 1);
  // A stored delivered row can carry a verification fact from another
  // writer (the natural flow stamps none on a delivered claim); the
  // reopen must clear it — no verdict recorded against the previous
  // owner stands over the new owner's round. Constructed directly, the
  // same idiom as the canCloseWork pin below.
  const sentBack = recordReview(delivered, "sage", { verdict: "changes_requested", summary: "redo" });
  const back = updateWork(sentBack, "sage", { state: "in_progress", authority: true });
  const stored = { ...delivered, verification: back.verification };
  assert.equal(reassignWork(stored, "lead", "instinct", { authority: true }).verification, null);
});

test("reassign: a fresh assignment clears a dirty row's whole round", () => {
  // The surviving descendant of WC-21/WC-22's clearing concern: on the
  // fresh-assignment branch, clearing IS the contract — an unclaimed row
  // still carrying a previous round's state (legacy rows predate the
  // clearing writers) starts the incoming owner's round from zero.
  const active = start(createWork({ id: "w-mut-7b", reviewPolicy: "distinct_member" }, { agentId: "quill" }));
  const delivered = updateWork(active, "quill", { state: "delivered", delivery: bundle() });
  const settled = recordCi(delivered, { state: "success", headSha: HEAD }, Date.now()).item;
  const sentBack = recordReview(settled, "sage", { verdict: "changes_requested", summary: "redo" });
  const back = updateWork(sentBack, "sage", { state: "in_progress", authority: true });
  const dirty = { ...back, state: "unclaimed", owner: null };
  assert.ok(dirty.delivery && dirty.verification && dirty.ci && dirty.deliveryGeneration === 1);
  const assigned = reassignWork(dirty, "lead", "instinct", { authority: true });
  assert.equal(assigned.owner, "instinct");
  assert.equal(assigned.state, "claimed");
  assert.equal(assigned.delivery, null);
  assert.equal(assigned.verification, null);
  assert.equal(assigned.ci, null);
  assert.equal(assigned.deliveryGeneration, 0);
});

test("reassign: a live round keeps its round across a mid-round handover", () => {
  // The third branch of the #3867 contract: reassigning a claim mid-round
  // (in_progress, e.g. after a send-back) hands the round itself over —
  // the delivery and its send-back fact stand, bound to the same digest
  // and generation, so the incoming owner answers the same review. If
  // this ever starts clearing, that is a deliberate contract change,
  // not a silent drift.
  const active = start(createWork({ id: "w-mut-7c", reviewPolicy: "distinct_member" }, { agentId: "quill" }));
  const delivered = updateWork(active, "quill", { state: "delivered", delivery: bundle() });
  const sentBack = recordReview(delivered, "sage", { verdict: "changes_requested", summary: "redo" });
  const back = updateWork(sentBack, "sage", { state: "in_progress", authority: true });
  assert.ok(back.delivery && back.verification);
  const reassigned = reassignWork(back, "lead", "instinct", { authority: true });
  assert.equal(reassigned.owner, "instinct");
  assert.equal(reassigned.state, "in_progress");
  assert.equal(reassigned.delivery.digest, delivered.delivery.digest);
  assert.deepEqual(reassigned.verification, back.verification);
  assert.equal(reassigned.deliveryGeneration, back.deliveryGeneration);
});

test("round clearing: a fresh claim restarts the round — no inherited CI, generation zeroed", () => {
  // Kills WC-32/WC-33 (claimWork keeps a stored row's CI record / its
  // delivery generation). Rows can carry round state the kernel's own
  // writers would have cleared; the claim is the last chance to drop it
  // (#3684/#3685: a stale generation or CI stamp binds the new round to
  // the old round's evidence).
  const active = start(createWork({ id: "w-mut-8", reviewPolicy: "distinct_member" }, { agentId: "quill" }));
  const delivered = updateWork(active, "quill", { state: "delivered", delivery: bundle() });
  assert.equal(delivered.deliveryGeneration, 1);
  const ciRecord = recordCi(delivered, { state: "success", headSha: HEAD }, Date.now()).item.ci;
  const released = updateWork(delivered, "quill", { state: "unclaimed" });
  const stored = { ...released, ci: ciRecord }; // a row still carrying the old round's CI
  const claimed = claimWork(stored, "sage", {});
  assert.equal(claimed.ci, null);
  assert.equal(claimed.deliveryGeneration, 0);
});

test("delivery generation advances on every finish, so approvals go stale by round", () => {
  // Kills WC-29 (finish leaves deliveryGeneration unchanged, #3684). The
  // generation is what binds a review to the delivery it actually saw;
  // if it never moves, a round-1 approval silently covers round 2.
  const active = start(createWork({ id: "w-mut-9", reviewPolicy: "distinct_member" }, { agentId: "quill" }));
  const delivered = updateWork(active, "quill", { state: "delivered", delivery: bundle() });
  assert.equal(delivered.deliveryGeneration, 1);
  const sentBack = recordReview(delivered, "sage", { verdict: "changes_requested", summary: "redo" });
  const back = updateWork(sentBack, "sage", { state: "in_progress", authority: true });
  const redelivered = updateWork(back, "quill", { state: "delivered", delivery: bundle() });
  assert.equal(redelivered.deliveryGeneration, 2);
});

test("canCloseWork: every leg of the close gate holds on its own", () => {
  // Kills WC-24/WC-26/WC-27/WC-28 (one leg each removed from
  // canCloseWork). Each case below satisfies every OTHER leg, so only
  // the named leg can be what refuses.
  const active = start(createWork({ id: "w-mut-10", reviewPolicy: "distinct_member" }, { agentId: "quill" }));
  const delivered = updateWork(active, "quill", { state: "delivered", delivery: bundle() });
  const reviewed = recordReview(delivered, "sage", { verdict: "approve", summary: "checks out" });
  const opts = { policy: "distinct_member", reviewMembers: ["quill", "sage"] };
  assert.equal(canCloseWork(reviewed, "sage", opts), true); // control: all legs satisfied
  // WC-27: the approver is not in the named reviewer set.
  assert.equal(canCloseWork(reviewed, "sage", { ...opts, reviewMembers: ["someone-else"] }), false);
  // WC-26: the approval has no attestation bound to the same instant.
  assert.equal(canCloseWork({ ...reviewed, attestations: Object.freeze([]) }, "sage", opts), false);
  // WC-24: the approving review is the owner's own (a stored row can
  // carry one even though recordReview refuses to write it — the
  // predicate is the last line for rows from any writer).
  const ownReview = {
    ...reviewed,
    reviews: Object.freeze(reviewed.reviews.map(r => ({ ...r, memberId: "quill" }))),
    attestations: Object.freeze(reviewed.attestations.map(a => ({ ...a, memberId: "quill" }))),
  };
  assert.equal(canCloseWork(ownReview, "quill", opts), false);
  // WC-28: under self_attested only the owner may close — not anyone.
  const own = start(createWork({ id: "w-mut-11" }, { agentId: "quill" }));
  assert.equal(canCloseWork(own, "quill", {}), true);
  assert.equal(canCloseWork(own, "mallory", {}), false);
});

test("bundle contract: a criteria-bearing claim needs a bundle even when self-attested", () => {
  // Kills WC-05 (bundle-required drops the criteria leg). The one
  // legitimate bundle-less finish is self-attested AND criteria-less
  // (pinned by "a criteria-less claim still finishes with a note alone").
  const item = start(createWork({ id: "w-mut-2", acceptanceCriteria: ["tests green"] }, { agentId: "quill" }));
  assert.throws(() => updateWork(item, "quill", { state: "done", note: "trust me" }),
    error => error.code === "delivery_incomplete" && /requires a delivery bundle/.test(error.message));
  // Control: the same claim finishes once the bundle is supplied.
  const done = updateWork(item, "quill", { state: "done",
    delivery: bundle({ criteria: [{ criterion: "tests green", status: "met" }] }) });
  assert.equal(done.state, "done");
});
