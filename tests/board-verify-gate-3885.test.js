// Board batch Slice R — #3885 + #3889.
// #3885: the board offered Verify under independent_principal to
// approvers who lack the verify permission; the kernel (canCloseWork)
// refused their verify. #3887's render half rides along: under
// self_attested the owner closes a delivered claim by their own verify,
// but the old approval-only gate could never render it for them.
// canVerifyClaim is the render-side mirror of canCloseWork.
// #3889: the review submit never named expectedBasis, so an identical
// re-review after the basis moved (new CI head) silently recorded
// nothing while the board announced "Reviewed". claimReviewBody now
// names the basis the reviewer read, from the item the form rendered.
import test from "node:test";
import assert from "node:assert/strict";
import { boardHtml, canVerifyClaim, claimReviewBody, claimReviewBasis } from "../src/board-ui.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const T0 = "2026-10-16T10:00:00.000Z";
const DIGEST = "a".repeat(64);

const members = {
  "agent-1": { id: "agent-1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-1": { id: "rev-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-2": { id: "rev-2", kind: "human", active: true, permissions: ["accept_work", "complete_work", "verify"] },
  "rev-3": { id: "rev-3", kind: "human", active: false, permissions: ["accept_work", "complete_work", "verify"] },
};
const asViewer = id => ({ id, manage: false, owner: false, write: true });

const deliveredBundle = (digest = DIGEST) => ({
  artifact: { kind: "report", ref: "https://example.com/results/claim", sha256: DIGEST },
  checks: [{ name: "unit", result: "pass" }], criteria: [],
  digest, deliveredBy: "agent-1", deliveredAt: T0,
});
const approvedBy = (memberId, extra = {}) => ({
  state: "delivered",
  delivery: deliveredBundle(),
  deliveryGeneration: 1,
  reviews: [{ memberId, verdict: "approve", summary: "looks right", at: "2026-10-16T11:00:00.000Z",
    basis: { version: 1, owner: "agent-1", claimedAt: T0, revision: null, headSha: null, deliveryDigest: DIGEST, deliveryGeneration: 1 } }],
  attestations: [{ memberId, at: "2026-10-16T11:00:00.000Z", note: "looks right" }],
  ...extra,
});
const claim = (id, extra = {}) => ({
  id, title: `Title ${id}`, state: "in_progress", owner: "agent-1", kind: "task",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [],
  claimedAt: T0, ...extra,
});

test("#3885: independent_principal offers Verify only to an approver holding the verify permission", () => {
  const byRev1 = claim("wc_a", approvedBy("rev-1", { reviewPolicy: "independent_principal" }));
  assert.equal(canVerifyClaim(byRev1, asViewer("rev-1"), members), false,
    "approve + review standing but no verify permission: the kernel would refuse — do not offer");
  const byRev2 = claim("wc_b", approvedBy("rev-2", { reviewPolicy: "independent_principal" }));
  assert.equal(canVerifyClaim(byRev2, asViewer("rev-2"), members), true,
    "approve + verify permission: offered");
});

test("distinct_member keeps offering Verify to a standing approver without the verify permission", () => {
  const item = claim("wc_c", approvedBy("rev-1", { reviewPolicy: "distinct_member" }));
  assert.equal(canVerifyClaim(item, asViewer("rev-1"), members), true);
});

test("#3887: self_attested offers Verify to the owner of a delivered claim (no approval exists or can exist)", () => {
  const item = claim("wc_d", { state: "delivered", delivery: deliveredBundle(), deliveryGeneration: 1, reviewPolicy: "self_attested" });
  assert.equal(canVerifyClaim(item, asViewer("agent-1"), members), true, "the owner is the kernel's closer");
  assert.equal(canVerifyClaim(item, asViewer("rev-1"), members), false, "nobody else closes a self-attested claim");
});

test("verify stays unoffered for owners under reviewed policies, stale approvals, and inactive members", () => {
  const item = claim("wc_e", approvedBy("rev-1", { reviewPolicy: "distinct_member" }));
  assert.equal(canVerifyClaim(item, asViewer("agent-1"), members), false, "the owner never verifies under a reviewed policy");
  const stale = claim("wc_f", approvedBy("rev-1", { reviewPolicy: "distinct_member", delivery: deliveredBundle("b".repeat(64)), deliveryGeneration: 2 }));
  assert.equal(canVerifyClaim(stale, asViewer("rev-1"), members), false, "a stale-basis approval does not close");
  const byRev3 = claim("wc_g", approvedBy("rev-3", { reviewPolicy: "independent_principal" }));
  assert.equal(canVerifyClaim(byRev3, asViewer("rev-3"), members), false, "an inactive member is not a reviewer of record");
  assert.equal(canVerifyClaim(claim("wc_h", { state: "in_progress" }), asViewer("rev-1"), members), false, "delivered only");
});

test("the card HTML follows the gate: no Verify button for the #3885 approver, one for the #3887 owner", () => {
  const refused = boardHtml([claim("wc_i", approvedBy("rev-1", { reviewPolicy: "independent_principal" }))], null, asViewer("rev-1"), members, NOW, {});
  assert.doesNotMatch(refused, /data-claim-action="verify"/);
  const own = boardHtml([claim("wc_j", { state: "delivered", delivery: deliveredBundle(), deliveryGeneration: 1, reviewPolicy: "self_attested" })], null, asViewer("agent-1"), members, NOW, {});
  assert.match(own, /data-claim-action="verify"/);
});

test("#3889: the review body names the basis the reviewer read, in the kernel's shape", () => {
  const item = claim("wc_k", {
    state: "delivered", revision: "r-9", ci: { headSha: "c".repeat(40) },
    delivery: deliveredBundle(), deliveryGeneration: 3,
  });
  assert.deepEqual(claimReviewBasis(item), {
    version: 1, owner: "agent-1", claimedAt: T0, revision: "r-9",
    headSha: "c".repeat(40), deliveryDigest: DIGEST, deliveryGeneration: 3,
  });
  const body = claimReviewBody(item, "approve", "LGTM");
  assert.equal(body.verdict, "approve");
  assert.equal(body.summary, "LGTM");
  assert.deepEqual(body.expectedBasis, claimReviewBasis(item));
  // An ownerless item has no basis to name; the body stays the plain pair.
  assert.deepEqual(claimReviewBody(claim("wc_l", { owner: null }), "comment", "hi"), { verdict: "comment", summary: "hi" });
});
