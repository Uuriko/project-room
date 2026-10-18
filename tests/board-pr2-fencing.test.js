// BOARD-PR2-FENCING: sweep lane-10 Mediums F2/F4/F5/F6 (issues
// #3885/#3887/#3888/#3889), pinned failing-first against the board as
// landed (the PR-1 round-fencing state — none of these surfaces are
// touched by PR-1). F3 (#3886) is Dot case 4, pinned in
// board-round-fencing.test.js; F7/F8 (#3890/#3891) live in the cockpit
// files; F9 (#3892) is an app.js patch specified in PR2.md.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as boardUi from "../src/board-ui.js";
import { boardHtml } from "../src/board-ui.js";
import { createWork, claimWork, updateWork, recordReview, recordCi } from "../server/work-claims.mjs";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const T0 = "2026-10-16T10:00:00.000Z";
const DIGEST = "a".repeat(64);
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const members = {
  "agent-1": { id: "agent-1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  // rev-1 can review (accept/complete) but does NOT hold verify.
  "rev-1": { id: "rev-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
  // rev-2 holds verify as well.
  "rev-2": { id: "rev-2", kind: "human", active: true, permissions: ["accept_work", "complete_work", "verify"] },
};
const worker = { id: "agent-1", manage: false, owner: false, write: true };
const reviewer = { id: "rev-1", manage: false, owner: false, write: true };
const verifier = { id: "rev-2", manage: false, owner: false, write: true };
const manager = { id: "rev-1", manage: true, owner: false, write: true };

const claim = (id, extra = {}) => ({
  id, title: `Title ${id}`, state: "in_progress", owner: "agent-1", kind: "task",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [],
  claimedAt: T0, ...extra,
});
const render = (items, viewer, opts = {}) => boardHtml(items, null, viewer, members, NOW, opts);

// A delivered claim whose rev-1 approval is current against its delivery.
const approvedDelivered = (id, extra = {}) => claim(id, {
  state: "delivered", reviewPolicy: "independent_principal",
  pullRequest: { url: "https://github.com/o/r/pull/7" },
  delivery: { artifact: { kind: "report", ref: "https://example.com/results/x", sha256: DIGEST },
    checks: [{ name: "unit", result: "pass" }], criteria: [], digest: DIGEST, deliveredBy: "agent-1", deliveredAt: T0 },
  deliveryGeneration: 1,
  reviews: [{ memberId: "rev-1", verdict: "approve", summary: "looks right", at: "2026-10-16T11:00:00.000Z",
    basis: { version: 1, owner: "agent-1", claimedAt: T0, revision: null, headSha: null, deliveryDigest: DIGEST, deliveryGeneration: 1 } }],
  attestations: [{ memberId: "rev-1", at: "2026-10-16T11:00:00.000Z", note: "looks right" }],
  ...extra,
});

// --- F2 (#3885): Verify under independent_principal needs the verify permission ---

test("(F2) an approver without the verify permission is not offered Verify under independent_principal", () => {
  const html = render([approvedDelivered("wc_f2")], reviewer);
  assert.doesNotMatch(html, /data-claim-action="verify"/,
    "canCloseWork refuses this verify (reviewer not in verifyMembers); the card must not offer it");
});

test("(F2) an approver holding the verify permission is offered Verify under independent_principal", () => {
  const mine = approvedDelivered("wc_f2b", {
    reviews: [{ memberId: "rev-2", verdict: "approve", summary: "looks right", at: "2026-10-16T11:00:00.000Z",
      basis: { version: 1, owner: "agent-1", claimedAt: T0, revision: null, headSha: null, deliveryDigest: DIGEST, deliveryGeneration: 1 } }],
    attestations: [{ memberId: "rev-2", at: "2026-10-16T11:00:00.000Z", note: "looks right" }],
  });
  const html = render([mine], verifier);
  assert.match(html, /data-claim-action="verify"/);
});

test("(F2) distinct_member still offers Verify on a current approval alone", () => {
  const html = render([approvedDelivered("wc_f2c", { reviewPolicy: "distinct_member" })], reviewer);
  assert.match(html, /data-claim-action="verify"/, "canCloseWork asks nothing more of a distinct_member reviewer");
});

// --- F4 (#3887): a delivered self-attested claim closes by owner-verify ---

test("(F4) the owner of a delivered self-attested claim is offered Verify", () => {
  const html = render([claim("wc_f4", { state: "delivered", reviewPolicy: "self_attested",
    delivery: { artifact: { kind: "report", ref: "https://example.com/results/x", sha256: DIGEST },
      checks: [{ name: "unit", result: "pass" }], criteria: [], digest: DIGEST, deliveredBy: "agent-1", deliveredAt: T0 },
    deliveryGeneration: 1 })], worker);
  assert.match(html, /data-claim-action="verify"/,
    "canCloseWork under self_attested is reviewerId === owner; the board gate required an approval the owner can never hold");
});

test("(F4) a non-owner is not offered Verify on a delivered self-attested claim", () => {
  const html = render([claim("wc_f4b", { state: "delivered", reviewPolicy: "self_attested",
    delivery: { artifact: { kind: "report", ref: "https://example.com/results/x", sha256: DIGEST },
      checks: [{ name: "unit", result: "pass" }], criteria: [], digest: DIGEST, deliveredBy: "agent-1", deliveredAt: T0 },
    deliveryGeneration: 1 })], reviewer);
  assert.doesNotMatch(html, /data-claim-action="verify"/);
});

// --- F5 (#3888): send-back is reachable from the delivered card ---

const sentBack = (id, extra = {}) => claim(id, {
  state: "delivered", reviewPolicy: "distinct_member",
  pullRequest: { url: "https://github.com/o/r/pull/7" },
  delivery: { artifact: { kind: "report", ref: "https://example.com/results/x", sha256: DIGEST },
    checks: [{ name: "unit", result: "pass" }], criteria: [], digest: DIGEST, deliveredBy: "agent-1", deliveredAt: T0 },
  deliveryGeneration: 1,
  reviews: [{ memberId: "rev-1", verdict: "changes_requested", summary: "needs work", at: "2026-10-16T11:00:00.000Z",
    basis: { version: 1, owner: "agent-1", claimedAt: T0, revision: null, headSha: null, deliveryDigest: DIGEST, deliveryGeneration: 1 } }],
  ...extra,
});

test("(F5) the changes_requested reviewer is offered Send back on the delivered card", () => {
  assert.match(render([sentBack("wc_f5")], reviewer), /data-claim-action="sendback"/);
});

test("(F5) the owner and a claim manager are offered Send back; an uninvolved member is not", () => {
  assert.match(render([sentBack("wc_f5b")], worker), /data-claim-action="sendback"/, "the route authorizes the owner always");
  assert.match(render([sentBack("wc_f5b")], manager), /data-claim-action="sendback"/, "the route authorizes claim managers");
  const bystander = { id: "rev-2", manage: false, owner: false, write: true };
  assert.doesNotMatch(render([sentBack("wc_f5b")], bystander), /data-claim-action="sendback"/);
});

test("(F5) the send-back click posts the delivered → in_progress transition", () => {
  const source = readFileSync(new URL("../src/board-ui.js", import.meta.url), "utf8");
  assert.match(source, /action === "sendback"/, "the click handler wires the send-back action");
});

// --- F6 (#3889): a re-review names the basis it read ---

test("(F6) expectedReviewBasis names exactly the basis the kernel binds", () => {
  assert.equal(typeof boardUi.expectedReviewBasis, "function", "the basis builder exists");
  const item = claim("wc_f6", { revision: "abc123", ci: { state: "success", headSha: HEAD_A },
    delivery: { digest: DIGEST }, deliveryGeneration: 1 });
  assert.deepEqual(boardUi.expectedReviewBasis(item), {
    version: 1, owner: "agent-1", claimedAt: T0, revision: "abc123", headSha: HEAD_A,
    deliveryDigest: DIGEST, deliveryGeneration: 1,
  });
});

test("(F6) an identical re-review naming the moved basis refreshes the approval; without it, it no-ops", () => {
  let item = createWork({ id: "wc_f6k", reviewPolicy: "distinct_member" }, { agentId: "agent-1" });
  item = claimWork(item, "agent-1");
  item = updateWork(item, "agent-1", { state: "in_progress" });
  item = recordCi(item, { state: "success", headSha: HEAD_A }).item;
  item = recordReview(item, "rev-1", { verdict: "approve", summary: "LGTM" });
  const boundA = item.reviews.find(entry => entry.memberId === "rev-1");
  assert.equal(boundA.basis.headSha, HEAD_A);
  item = recordCi(item, { state: "success", headSha: HEAD_B }).item;
  // The board's re-review after the head moved, naming the basis it read:
  const named = boardUi.expectedReviewBasis(item);
  const refreshed = recordReview(item, "rev-1", { verdict: "approve", summary: "LGTM", expectedBasis: named });
  assert.equal(refreshed.reviews.find(entry => entry.memberId === "rev-1").basis.headSha, HEAD_B,
    "the deliberate re-review rebinds the approval to the current head");
  // Control: the same resubmission WITHOUT a named basis records nothing
  // and does not rebind the approval to the new head.
  const blind = recordReview(item, "rev-1", { verdict: "approve", summary: "LGTM" });
  assert.equal(blind.reviews.find(entry => entry.memberId === "rev-1").basis.headSha, HEAD_A,
    "a blind identical retry leaves the stale binding in place");
  assert.equal(blind.history.length, item.history.length, "…and appends no history");
});
