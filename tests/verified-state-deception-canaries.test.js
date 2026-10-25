// Regression canaries for #3683, #3684, #3685 — seeded from the
// DECEPTION-LEAGUE adversarial harness (2026-10-15). Each canary asserts the
// FIXED behavior of the verified-state machinery; every one of them failed
// on PR #3627 head ff7d680a78c2d5af28decbec6c3d954b547e3dcb, where the
// corresponding deception reproduced. Shapes follow
// tests/work-claim-verified-state.test.js and
// tests/public-work-verified-state.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWork, claimWork, updateWork, recordReview, recordCi, canCloseWork,
} from "../server/work-claims.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { publicWorkReviewsSchema } from "../server/public-work-reviews.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "f".repeat(64);
const HEAD1 = "b".repeat(40);
const goodBundle = { artifact: { kind: "text", ref: "room://artifacts/good", sha256: SHA_A },
  checks: [{ name: "unit", result: "pass" }],
  criteria: [{ criterion: "tests green", status: "met" }] };
// A different, still conforming delivery: same criteria honestly met, new
// artifact — used where a test must isolate one leg (a junk bundle would
// trip criteria_coverage first and mask the leg under test).
const goodBundle2 = { artifact: { kind: "text", ref: "room://artifacts/good-v2", sha256: SHA_B },
  checks: [{ name: "unit", result: "pass" }],
  criteria: [{ criterion: "tests green", status: "met" }] };
const junkBundle = { artifact: { kind: "text", ref: "room://artifacts/junk", sha256: SHA_B },
  checks: [{ name: "unit", result: "skipped" }],
  criteria: [{ criterion: "tests green", status: "not_met" }] };
const start = (item, owner = "quill") => updateWork(claimWork(item, owner), owner, { state: "in_progress" });
const reviewedItem = (over = {}) => start(createWork(
  { id: "w1", reviewPolicy: "distinct_member", acceptanceCriteria: ["tests green"], ...over }, { agentId: "quill" }));

// CANARY-1 (#3683, kernel): a mapping that declares non-conformance must not
// record a platform criteria_coverage pass.
test("canary: not_met mapping never earns criteria_coverage pass", () => {
  const delivered = updateWork(reviewedItem(), "quill",
    { state: "delivered", delivery: { artifact: { kind: "text", ref: "room://artifacts/x", sha256: SHA_A },
      checks: [{ name: "unit", result: "pass" }],
      criteria: [{ criterion: "tests green", status: "not_met" }] } });
  const reviewed = recordReview(delivered, "sage", { verdict: "approve", summary: "form complete" });
  assert.throws(() => updateWork(reviewed, "sage", { state: "done", reviewedBy: "sage", authority: true }),
    e => e.code === "delivery_check_failed");
});

// CANARY-1b (#3683, kernel): na whose evidenceRef names a blob that is not
// this delivery is not coverage either; na whose evidenceRef resolves to
// the delivered artifact itself is.
test("canary: na needs an evidenceRef that resolves to the delivery", () => {
  const phantom = updateWork(reviewedItem(), "quill",
    { state: "delivered", delivery: { artifact: { kind: "text", ref: "room://artifacts/x", sha256: SHA_A },
      checks: [{ name: "unit", result: "pass" }],
      criteria: [{ criterion: "tests green", status: "na", evidenceRef: "sha256:" + "0".repeat(64) }] } });
  const reviewedPhantom = recordReview(phantom, "sage", { verdict: "approve", summary: "mapped" });
  assert.throws(() => updateWork(reviewedPhantom, "sage", { state: "done", reviewedBy: "sage", authority: true }),
    e => e.code === "delivery_check_failed");
  const backed = updateWork(reviewedItem(), "quill",
    { state: "delivered", delivery: { artifact: { kind: "text", ref: "room://artifacts/x", sha256: SHA_A },
      checks: [{ name: "unit", result: "pass" }],
      criteria: [{ criterion: "tests green", status: "na", evidenceRef: "sha256:" + SHA_A }] } });
  const reviewedBacked = recordReview(backed, "sage", { verdict: "approve", summary: "na — the artifact shows why" });
  const done = updateWork(reviewedBacked, "sage", { state: "done", reviewedBy: "sage", authority: true });
  assert.equal(done.verification.executedChecks.find(e => e.name === "criteria_coverage")?.result, "pass");
});

// CANARY-2 (#3684, kernel): an approval is bound to the delivery digest it
// was recorded against; a re-delivery stales it like a CI head move does.
test("canary: approval of bundle A does not verify re-delivered bundle B", () => {
  let item = updateWork(reviewedItem(), "quill", { state: "delivered", delivery: goodBundle });
  item = recordReview(item, "sage", { verdict: "approve", summary: "A verified" });
  item = updateWork(item, "quill", { state: "in_progress" });              // send-back
  item = updateWork(item, "quill", { state: "delivered", delivery: junkBundle });
  assert.equal(canCloseWork(item, "sage", { policy: "distinct_member", reviewMembers: ["sage"] }), false);
});

// CANARY-3 (#3684, kernel): an approval recorded before any delivery
// exists attests the work in flight — the board's designed review flow
// (the repo's own board tests record the review, then the holder
// finishes, then the reviewer verifies) — so it covers the round's FIRST
// delivery. But it was recorded against no delivery, so a REPLACEMENT
// delivery is outside what it attested and the gate closes. (The league's
// sketch asserted the pre-delivery approval never counts at all; that
// reading contradicts the PR's pinned board flows, so the canary pins
// the strongest binding compatible with them: in-flight approvals die
// with the first replacement, exactly like delivery-bound ones.)
test("canary: pre-delivery approval never survives a delivery replacement", () => {
  let item = recordReview(reviewedItem(), "sage", { verdict: "approve", summary: "reviewed in flight" });
  item = updateWork(item, "quill", { state: "delivered", delivery: goodBundle });
  assert.equal(canCloseWork(item, "sage", { policy: "distinct_member", reviewMembers: ["sage"] }), true);
  item = updateWork(item, "quill", { state: "in_progress" });              // send-back
  item = updateWork(item, "quill", { state: "delivered", delivery: junkBundle });
  assert.equal(canCloseWork(item, "sage", { policy: "distinct_member", reviewMembers: ["sage"] }), false);
});

// CANARY-4 (#3685, kernel): re-delivery invalidates the CI record — a fresh
// round must not verify citing a head settled against another delivery.
// (The league's sketch re-delivered its junk bundle here; a conforming
// second bundle is used so criteria_coverage does not mask the CI leg, and
// the fresh approval mirrors B7b — the assertion is the league's own.)
test("canary: ci_settlement never cites a head settled against another delivery", () => {
  let item = recordCi(reviewedItem(), { state: "success", headSha: HEAD1, url: null }).item;
  item = updateWork(item, "quill", { state: "delivered", delivery: goodBundle });
  item = recordReview(item, "sage", { verdict: "approve", summary: "ok" });
  item = updateWork(item, "quill", { state: "in_progress" });
  item = updateWork(item, "quill", { state: "delivered", delivery: goodBundle2 });
  item = recordReview(item, "sage", { verdict: "approve", summary: "fresh look at the new bundle" });
  const done = updateWork(item, "sage", { state: "done", reviewedBy: "sage", authority: true });
  assert.equal(done.verification.executedChecks.some(e => e.name === "ci_settlement" && e.result === "pass"), false);
});

// CANARY-4b (#3685, kernel): release invalidates the CI record too — a
// completely fresh round (re-claim, new delivery, fresh approval) verifies
// without the round-1 settlement.
test("canary: release clears the CI record for the next round", () => {
  let item = recordCi(reviewedItem(), { state: "success", headSha: HEAD1, url: null }).item;
  item = updateWork(item, "quill", { state: "delivered", delivery: goodBundle });
  item = recordReview(item, "sage", { verdict: "approve", summary: "ok" });
  item = updateWork(item, "quill", { state: "unclaimed" });
  assert.equal(item.ci, null);
  item = start(item);
  item = updateWork(item, "quill", { state: "delivered", delivery: goodBundle2 });
  item = recordReview(item, "sage", { verdict: "approve", summary: "fresh round, fresh look" });
  const done = updateWork(item, "sage", { state: "done", reviewedBy: "sage", authority: true });
  assert.equal(done.verification.executedChecks.some(e => e.name === "ci_settlement"), false);
});

// CANARY-5 (#3683, public work): a not_met attestation earns neither a
// coverage pass nor the system_checked label.
function publicFixture(t, { artifactText = "the result" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "canary-pw-")), file = join(dir, "room.sqlite");
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create("Producer");
  const state = structuredClone(store.room("commons").state);
  state.members.reviewer = { id: "reviewer", revision: 1, kind: "agent", active: true, displayName: "Reviewer", permissions: ["read", "verify"] };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), "commons");
  store.projectOffers.create("commons", "owner", { requestId: "create", offerId: "verify-task", reviewerMemberIds: ["owner", "reviewer"],
    terms: { kind: "task", title: "Verify this result", summary: "Explicit feedback", acceptanceCriteria: ["Correct result"], repositoryUrl: "https://github.com/example/project", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human_with_agent_review" } } });
  store.projectOffers.transition("commons", "owner", "verify-task", "publish", { requestId: "publish", expectedRevision: 1 });
  store.publicWorkClaims.enable("commons", "owner", "verify-task", { requestId: "enable", expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["result.txt"] });
  store.publicWorkClaims.act("verify-task", producer.secret, "claim", { requestId: "claim", expectedTermsVersion: 1 });
  const finish = extra => store.publicWorkClaims.act("verify-task", producer.secret, "finish",
    { requestId: "finish", expectedTermsVersion: 1, generation: 1, artifactText, checksReported: ["unit: pass"], ...extra });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, finish };
}

test("canary: public receipt for not_met attestation is not system_checked", t => {
  const f = publicFixture(t, { artifactText: "not the result" });
  const receipt = f.finish({ criteriaAttestation: [{ criterion: "Correct result", status: "not_met" }] }).receipt;
  assert.notEqual(receipt.verification, "system_checked");
  assert.equal(receipt.executedChecks.some(e => e.name === "criteria_coverage" && e.result === "pass"), false);
});

test("canary: public na attestation needs an evidenceRef whose reported check passed", t => {
  const phantom = publicFixture(t, { artifactText: "anything at all" });
  const receipt = phantom.finish({ criteriaAttestation: [
    { criterion: "Correct result", status: "na", evidenceRef: "no/such/file.txt" }] }).receipt;
  assert.notEqual(receipt.verification, "system_checked");
  assert.equal(receipt.executedChecks.some(e => e.name === "criteria_coverage" && e.result === "pass"), false);
  const backed = publicFixture(t, { artifactText: "the result" });
  const backedReceipt = backed.finish({ criteriaAttestation: [
    { criterion: "Correct result", status: "na", evidenceRef: "unit" }] }).receipt;
  assert.equal(backedReceipt.executedChecks.find(e => e.name === "criteria_coverage")?.result, "pass");
  assert.equal(backedReceipt.verification, "system_checked");
});
