// L2-H5-1 — the human public receipt page must name the dispute decider.
//
// Register claim (WORKFLOW-LOOP L2, build 1528c577): the API read model
// exposes the decider — single-task reads carry
// `settlement.disputeDecider` (non-null on 16/16 settled tasks) — but the
// human receipt page for a ruled dispute (specimen
// /receipts/pwr_18eb8146…) contains the word "decider" 0 times and the
// decider id nowhere. The data reaches API readers but not the human
// public record.
//
// Behavior protected:
//   - a paid public-work receipt whose settlement bounty has a designated
//     dispute decider carries that same id at
//     `settlement.disputeDecider` on the public receipt read — the exact
//     value the task read already publishes — and the rendered detail
//     page shows a "Dispute decider" row naming it, including after the
//     dispute has actually been opened and ruled;
//   - a settlement with no designated decider (the sole named reviewer
//     is the poster) and a receipt with no settlement at all render no
//     decider row, no "null" text, and no crash.
//
// Seams: the real settlement rail + escrow dispute flow drives a real
// ledger (fixture mirrors tests/public-work-settlement-disputes.test.js),
// and the real public read model + renderer serve the page. No mocks of
// the code under test.
//
// Run: node --test tests/receipt-dispute-decider.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { publicReceiptById } from "../server/receipts-live.mjs";
import { renderReceiptDetailHtml, receiptJson } from "../server/receipts-page.mjs";

// Paid fixture: reviewers ['reviewer', 'reviewer2'] with poster 'owner'
// designate 'reviewer' (first non-poster reviewer) as the dispute
// decider at fund time (#3702). reviewers ['owner'] designate nobody.
function fixture(t, { reviewerMemberIds = ["reviewer", "reviewer2"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "receipt-dispute-decider-")), file = join(dir, "room.sqlite");
  let clock = Date.now();
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  const producer = store.identities.create("Producer");
  const state = structuredClone(store.room("commons").state);
  state.members.worker = { id: "worker", revision: 1, kind: "agent", active: true, displayName: "Worker", permissions: ["read"] };
  state.members.reviewer = { id: "reviewer", revision: 1, kind: "human", active: true, displayName: "Reviewer", permissions: ["read", "decide"] };
  state.members.reviewer2 = { id: "reviewer2", revision: 1, kind: "human", active: true, displayName: "Reviewer Two", permissions: ["read", "decide"] };
  state.members.rival = { id: "rival", revision: 1, kind: "agent", active: true, displayName: "Rival", permissions: ["read"] };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), "commons");
  store.db.prepare("INSERT INTO identity_links VALUES (?,?,?,?)").run("commons", producer.identityId, "worker", clock);
  store.bountyEscrow.ensureGenesis("commons");
  const terms = { kind: "task", title: "Paid public task", summary: "Settle me", acceptanceCriteria: ["Correct result"],
    repositoryUrl: "https://github.com/example/project", reward: { kind: "work_trade", unit: "credit", amountMinor: "4000" }, approvalPolicy: { mode: "human" } };
  store.projectOffers.create("commons", "owner", { requestId: "create", offerId: "paid-task", reviewerMemberIds, terms });
  store.projectOffers.transition("commons", "owner", "paid-task", "publish", { requestId: "publish", expectedRevision: 1 });
  store.publicWorkClaims.enable("commons", "owner", "paid-task",
    { requestId: "enable", expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["result.txt"] });
  store.publicWorkClaims.act("paid-task", producer.secret, "claim", { requestId: "claim", expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act("paid-task", producer.secret, "finish",
    { requestId: "finish", expectedTermsVersion: 1, generation: 1, artifactText: "the result", checksReported: ["checked"] }).receipt;
  const decideInput = (requestId, decision) => ({ requestId, expectedReviewRevision: 0, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256,
    reason: "Reviewed the exact artifact", decision });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, receipt, decideInput };
}

const bountyOf = store => store.bountyEscrow.getBounty("commons", store.publicWorkSettlement.link("paid-task").bounty_id);

test("ruled dispute: the human receipt page names the dispute decider the task API already publishes", t => {
  const f = fixture(t), { store } = f;
  const receipt = f.receipt, id = receipt.receiptId;

  // The already-public API value this page must match (settlement view =
  // the single-task read's settlement.disputeDecider source).
  assert.equal(store.publicWorkSettlement.viewForOffer("paid-task").disputeDecider, "reviewer");
  assert.equal(bountyOf(store).disputeDecider, "reviewer");

  // Accept, dispute, and rule it — the specimen's ruled-dispute shape.
  const outcome = store.publicWorkReviews.decide("commons", "reviewer2", id, f.decideInput("accept-1", "accepted"));
  assert.equal(outcome.settlement.phase, "accepted");
  const { dispute } = store.bountyEscrow.disputeBounty("commons", bountyOf(store).bountyId,
    { challenger: "rival", bond: 1, grounds: "junk artifact" });
  assert.equal(dispute.decider, "reviewer");
  const ruled = store.bountyEscrow.decideDispute("commons", bountyOf(store).bountyId,
    { decider: "reviewer", outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(ruled.bounty.state, "refunded");

  const pub = publicReceiptById(store, id);
  assert.ok(pub, "the settled work receipt must resolve");
  assert.equal(pub.settlement?.disputeDecider, "reviewer",
    "the public receipt read carries the decider, as the task read does");

  const json = receiptJson(pub);
  assert.equal(json.settlement?.disputeDecider, "reviewer");

  const html = renderReceiptDetailHtml(pub);
  assert.match(html, /<dt>Dispute decider<\/dt><dd>reviewer<\/dd>/,
    "the human page names who ruled the dispute");
});

test("settled receipt with a designated decider shows it even before any dispute opens", t => {
  const f = fixture(t), { store } = f;
  const pub = publicReceiptById(store, f.receipt.receiptId);
  assert.equal(pub.settlement?.disputeDecider, "reviewer");
  assert.match(renderReceiptDetailHtml(pub), /<dt>Dispute decider<\/dt><dd>reviewer<\/dd>/);
});

test("no designated decider: no decider row, no null text, page still renders", t => {
  const f = fixture(t, { reviewerMemberIds: ["owner"] }), { store } = f;
  assert.equal(store.publicWorkSettlement.viewForOffer("paid-task").disputeDecider, null);
  const pub = publicReceiptById(store, f.receipt.receiptId);
  assert.ok(pub);
  assert.equal(pub.settlement?.disputeDecider ?? null, null);
  const html = renderReceiptDetailHtml(pub);
  assert.match(html, /Paid public task/);
  assert.doesNotMatch(html, /Dispute decider/);
  assert.doesNotMatch(html, /<dd>null<\/dd>/);
});

test("renderer alone: absent or null decider renders nothing extra and never crashes", () => {
  const base = {
    schema: "project-room-public-receipt/1",
    id: "pwr_" + "ab".repeat(32),
    title: "Public work: no settlement",
    source: "public-work",
    room: { id: "commons", title: "Commons" },
    agents: ["worker"], humans: [],
    pullRequest: null, mergedAt: null,
    hashes: [], at: "2026-10-07T18:00:00.000Z",
    startHref: "https://room.trydemigod.com/?start=room",
    state: "submitted", verification: "hash_only",
  };
  for (const receipt of [base, { ...base, settlement: { disputeDecider: null } }, { ...base, settlement: {} }]) {
    const html = renderReceiptDetailHtml(receipt);
    assert.match(html, /Public work: no settlement/);
    assert.doesNotMatch(html, /Dispute decider/);
  }
  const withDecider = renderReceiptDetailHtml({ ...base, settlement: { disputeDecider: "ai_testdecider1" } });
  assert.match(withDecider, /<dt>Dispute decider<\/dt><dd>ai_testdecider1<\/dd>/);
});
