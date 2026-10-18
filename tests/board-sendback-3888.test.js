// Board batch Slice D — #3886 + #3888.
// #3886: the board's one-step Done (in_progress -> done collapse) runs
// the kernel's finish path, which requires a complete delivery bundle
// whenever the claim carries acceptance criteria — under self_attested
// too (requireBundleComplete, bundle = the posted delivery or the one
// on record). A criteria-bearing self-attested claim with no bundle on
// record now gets the deliver form instead of a Done the kernel
// refuses delivery_incomplete.
// #3888: changes_requested was a board dead end — the kernel's
// send-back (delivered -> in_progress) and its route gate existed, but
// no human-UI control posted it. The card now offers Send back to
// exactly the people the route authorizes.
import test from "node:test";
import assert from "node:assert/strict";
import { boardHtml, canSendBackClaim, claimSendBackBody } from "../src/board-ui.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const T0 = "2026-10-16T10:00:00.000Z";
const DIGEST = "a".repeat(64);

const members = {
  "agent-1": { id: "agent-1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-1": { id: "rev-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-2": { id: "rev-2", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
  "mgr-1": { id: "mgr-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
};
const worker = { id: "agent-1", manage: false, owner: false, write: true };
const asViewer = (id, extra = {}) => ({ id, manage: false, owner: false, write: true, ...extra });

const deliveredBundle = () => ({
  artifact: { kind: "report", ref: "https://example.com/results/claim", sha256: DIGEST },
  checks: [{ name: "unit", result: "pass" }], criteria: [],
  digest: DIGEST, deliveredBy: "agent-1", deliveredAt: T0,
});
const claim = (id, extra = {}) => ({
  id, title: `Title ${id}`, state: "in_progress", owner: "agent-1", kind: "task",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [],
  claimedAt: T0, ...extra,
});
const render = (items, viewer, opts = {}) => boardHtml(items, null, viewer, members, NOW, opts);

test("#3886: a criteria-bearing self-attested claim with no bundle on record gets the deliver form, not Done", () => {
  const html = render([claim("wc_a", { acceptanceCriteria: ["Return exact bytes"], reviewPolicy: "self_attested" })], worker);
  assert.match(html, /data-claim-deliver="wc_a"/, "the finish is the bundle-composing step");
  assert.doesNotMatch(html, /data-claim-action="done"/, "a bare Done would be refused delivery_incomplete");
});

test("#3886: criteria-free self-attested keeps one-step Done; a recorded bundle keeps it too", () => {
  const plain = render([claim("wc_b", { reviewPolicy: "self_attested" })], worker);
  assert.match(plain, /data-claim-action="done"/);
  assert.doesNotMatch(plain, /data-claim-deliver/);
  const retained = render([claim("wc_c", { acceptanceCriteria: ["Return exact bytes"], reviewPolicy: "self_attested", delivery: deliveredBundle(), deliveryGeneration: 1 })], worker);
  assert.match(retained, /data-claim-action="done"/, "the bundle on record satisfies the collapse (e.g. retained through a send-back)");
});

test("#3888: Send back is offered to exactly the route's three authorized callers", () => {
  const sent = claim("wc_d", {
    state: "delivered", delivery: deliveredBundle(), deliveryGeneration: 1,
    reviews: [{ memberId: "rev-1", verdict: "changes_requested", summary: "needs rework", at: "2026-10-16T11:00:00.000Z",
      basis: { version: 1, owner: "agent-1", claimedAt: T0, revision: null, headSha: null, deliveryDigest: DIGEST, deliveryGeneration: 1 } }],
  });
  assert.equal(canSendBackClaim(sent, asViewer("agent-1")), true, "the owner");
  assert.equal(canSendBackClaim(sent, asViewer("mgr-1", { manage: true })), true, "a claim manager");
  assert.equal(canSendBackClaim(sent, asViewer("rev-1")), true, "the reviewer who recorded changes_requested");
  assert.equal(canSendBackClaim(sent, asViewer("rev-2")), false, "any other reviewer");
  assert.equal(canSendBackClaim(sent, asViewer("rev-2", { write: false })), false, "a bystander");
  const noSendReview = claim("wc_e", { state: "delivered", delivery: deliveredBundle(), deliveryGeneration: 1 });
  assert.equal(canSendBackClaim(noSendReview, asViewer("rev-1")), false, "no changes_requested review, no send-back");
  assert.equal(canSendBackClaim(claim("wc_f", { state: "in_progress" }), asViewer("agent-1")), false, "delivered only");
});

test("#3888: the card renders Send back for the changes-requested reviewer, and the body carries its operation identity", () => {
  const sent = claim("wc_g", {
    state: "delivered", delivery: deliveredBundle(), deliveryGeneration: 2,
    reviews: [{ memberId: "rev-1", verdict: "changes_requested", summary: "needs rework", at: "2026-10-16T11:00:00.000Z",
      basis: { version: 1, owner: "agent-1", claimedAt: T0, revision: null, headSha: null, deliveryDigest: DIGEST, deliveryGeneration: 2 } }],
  });
  assert.match(render([sent], asViewer("rev-1")), /data-claim-action="send-back"/);
  assert.doesNotMatch(render([sent], asViewer("rev-2")), /data-claim-action="send-back"/);
  assert.deepEqual(claimSendBackBody(sent, "rev-1"), { state: "in_progress", requestId: "send-back-wc_g-2-rev-1" });
});
