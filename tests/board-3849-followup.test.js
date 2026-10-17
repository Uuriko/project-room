// BOARD-3849-FOLLOWUP: three defects in the board slice #3849 as landed,
// reported by external review (issue #3299 comment 6229556362) and verified
// independently against main:
// (a) the board Verify POST carried no requestId and no readback, so the
//     exact-retry machinery (#3829's contract: a requestId in the update
//     body, outcome bound to the reviewer) could never engage from the UI —
//     a lost response left the reviewer with an error and a claim whose
//     state they could not confirm from the card.
// (b) the claim record rendered delivery.result / merged / production —
//     fields the kernel never stores — while the actual delivery evidence
//     (artifact / checks / criteria, work-claims.mjs deliveryOf) stayed
//     hidden; the render fixture used the same noncanonical field, so the
//     suite passed while real evidence was invisible.
// (c) the board Deliver POST carried no bundle, so a first finish under a
//     reviewed policy always landed in delivery_incomplete; only
//     re-delivery worked, because the kernel reuses the stored bundle.
import test from "node:test";
import assert from "node:assert/strict";
import { boardHtml, claimDeliverForm, claimDeliverBody, claimVerifyBody, verifyRequestId } from "../src/board-ui.js";
import { createWork, claimWork, updateWork, recordReview, deliveryDigest } from "../server/work-claims.mjs";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const T0 = "2026-10-16T10:00:00.000Z";
const SHA = "a".repeat(64);
const DIGEST = "d".repeat(64);

const members = {
  "agent-1": { id: "agent-1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-1": { id: "rev-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
};
const reviewer = { id: "rev-1", manage: false, owner: false, write: true };
const worker = { id: "agent-1", manage: false, owner: false, write: true };
const claim = (id, extra = {}) => ({
  id, title: `Title ${id}`, state: "in_progress", owner: "agent-1", kind: "task",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [],
  claimedAt: T0, ...extra,
});
const render = (items, viewer, opts = {}) => boardHtml(items, null, viewer, members, NOW, opts);

// --- (b) the record renders the kernel's actual evidence fields ---

// The shape work-claims.mjs freezes at finish: the bundle's
// { artifact, checks, criteria } plus digest / deliveredBy / deliveredAt.
const kernelDelivery = {
  artifact: { kind: "report", ref: "https://example.com/results/wc_b", sha256: SHA },
  checks: [{ name: "unit tests", result: "pass", command: "npm test" }],
  criteria: [{ criterion: "Done when the tests pass", status: "met" }],
  digest: DIGEST, deliveredBy: "agent-1", deliveredAt: T0,
};

test("(b) the record shows the delivered artifact, checks and criteria mapping", () => {
  const html = render([claim("wc_b", { state: "delivered", delivery: kernelDelivery, deliveryGeneration: 1,
    pullRequest: { url: "https://github.com/o/r/pull/7" } })], reviewer);
  assert.match(html, /https:\/\/example\.com\/results\/wc_b/, "the artifact ref is on the record");
  assert.match(html, new RegExp(SHA), "the artifact sha256 is on the record");
  assert.match(html, /unit tests/, "the caller-reported check is on the record");
  assert.match(html, /Done when the tests pass/, "the mapped criterion is on the record");
  assert.match(html, /met/, "the criterion status is on the record");
});

test("(b) a delivery with no artifact still shows its checks and deliverer", () => {
  const delivery = { checks: [{ name: "manual review", result: "pass" }], criteria: [],
    digest: DIGEST, deliveredBy: "agent-1", deliveredAt: T0 };
  const html = render([claim("wc_b2", { state: "delivered", delivery, deliveryGeneration: 1,
    pullRequest: { url: "https://github.com/o/r/pull/7" } })], reviewer);
  assert.match(html, /manual review/, "checks render even when the bundle carries no artifact");
});

// --- (a) Verify preserves operation identity ---

test("(a) verifyRequestId is stable for one verify operation and bound to its round and reviewer", () => {
  const item = claim("wc_a", { state: "delivered", deliveryGeneration: 1 });
  assert.equal(verifyRequestId(item, "rev-1"), verifyRequestId(item, "rev-1"),
    "a retry of the same click re-sends the same id — that is what makes it an exact retry");
  assert.notEqual(verifyRequestId(item, "rev-1"), verifyRequestId({ ...item, deliveryGeneration: 2 }, "rev-1"),
    "a re-delivery is a new operation and must not replay the old verify");
  assert.notEqual(verifyRequestId(item, "rev-1"), verifyRequestId(item, "rev-2"),
    "another reviewer's verify is a different operation (#3829 binds the outcome to the actor)");
  assert.match(verifyRequestId(item, "rev-1"), /^[A-Za-z0-9_-]{1,128}$/,
    "the id fits the route's requestId shape");
});

test("(a) the board's verify body carries the requestId the retry contract expects", () => {
  const item = claim("wc_a", { state: "delivered", deliveryGeneration: 1 });
  assert.deepEqual(claimVerifyBody(item, "rev-1"), { state: "done", requestId: verifyRequestId(item, "rev-1") });
});

test("(a) a verify carrying the board's requestId records its outcome; the identical retry replays it", () => {
  // Kernel-level composition pin: the machinery the client's requestId
  // engages. updateWork records the outcome under the requestId, and the
  // same body replayed after completion returns the landed item with no
  // new history — one durable effect. (The route-level half — letting the
  // retry past the owner gate once the claim is done, bound to the
  // reviewer — is PR #3829's server change; this pins the kernel contract
  // both sides compose with.)
  let item = createWork({ id: "wc_a", reviewPolicy: "distinct_member" }, { agentId: "agent-1" });
  item = updateWork(claimWork(item, "agent-1"), "agent-1", { state: "in_progress" });
  item = updateWork(item, "agent-1", { state: "delivered",
    delivery: { artifact: { kind: "text", ref: "room://artifacts/1", sha256: SHA },
      checks: [{ name: "unit", result: "pass" }], criteria: [] } });
  item = recordReview(item, "rev-1", { verdict: "approve", summary: "checks out" });
  const body = claimVerifyBody(item, "rev-1");
  const done = updateWork(item, "rev-1", { ...body, authority: true });
  assert.equal(done.state, "done");
  assert.ok(done.requestOutcomes?.[body.requestId], "the landed verify records its requestId outcome");
  const replayed = updateWork(done, "rev-1", { ...body, authority: true });
  assert.equal(replayed.state, "done");
  assert.equal(replayed.history.length, done.history.length, "the retry appends no second effect");
});

// --- (c) first Deliver under a reviewed policy carries a valid bundle ---

test("(c) the old board body — state alone — is refused delivery_incomplete (the failure shape)", () => {
  let item = createWork({ id: "wc_c0", reviewPolicy: "distinct_member",
    acceptanceCriteria: ["tests green"] }, { agentId: "agent-1" });
  item = updateWork(claimWork(item, "agent-1"), "agent-1", { state: "in_progress" });
  assert.throws(() => updateWork(item, "agent-1", { state: "delivered" }),
    error => error.code === "delivery_incomplete");
});

const deliverForm = fields => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
};
// The form's repeated rows share one field name each (checkName /
// checkResult / criterion), read back in order — build the multi-row
// entries with append, the way a browser submits them.
const validFields = () => {
  const form = new FormData();
  form.set("artifactKind", "report");
  form.set("artifactRef", "https://example.com/results/wc_c");
  form.set("artifactSha256", SHA);
  form.append("checkName", "unit tests");
  form.append("checkResult", "pass");
  form.append("criterion", "met");
  return form;
};
const withField = (form, name, value) => { form.set(name, value); return form; };
const criteriaClaim = (extra = {}) => claim("wc_c", {
  reviewPolicy: "distinct_member", acceptanceCriteria: ["tests green"], ...extra,
});

test("(c) claimDeliverBody composes a bundle the kernel accepts as a first delivery", () => {
  const body = claimDeliverBody(criteriaClaim(), validFields(), "agent-1");
  assert.equal(body.state, "delivered");
  assert.match(body.requestId, /^[A-Za-z0-9_-]{1,128}$/, "the deliver carries its own operation identity");
  let item = createWork({ id: "wc_c", reviewPolicy: "distinct_member",
    acceptanceCriteria: ["tests green"] }, { agentId: "agent-1" });
  item = updateWork(claimWork(item, "agent-1"), "agent-1", { state: "in_progress" });
  const delivered = updateWork(item, "agent-1", body);
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.delivery.digest, deliveryDigest(body.delivery), "the composed bundle froze with its digest");
  assert.deepEqual(delivered.delivery.criteria, [{ criterion: "tests green", status: "met" }]);
});

test("(c) claimDeliverBody refuses an incomplete bundle instead of posting one the kernel must refuse", () => {
  assert.equal(claimDeliverBody(criteriaClaim(), withField(validFields(), "artifactSha256", ""), "agent-1"), null,
    "no artifact sha, no post");
  assert.equal(claimDeliverBody(criteriaClaim(), withField(validFields(), "artifactSha256", "not-a-sha"), "agent-1"), null,
    "the sha must be 64 hex");
  const noCheck = new FormData();
  noCheck.set("artifactKind", "report"); noCheck.set("artifactRef", "https://example.com/r"); noCheck.set("artifactSha256", SHA);
  noCheck.append("criterion", "met");
  assert.equal(claimDeliverBody(criteriaClaim(), noCheck, "agent-1"), null,
    "at least one named check is required");
  const noCriteria = deliverForm({ artifactKind: "report", artifactRef: "https://example.com/r", artifactSha256: SHA });
  noCriteria.append("checkName", "unit"); noCriteria.append("checkResult", "pass");
  assert.equal(claimDeliverBody(criteriaClaim(), noCriteria, "agent-1"), null, "every acceptance criterion must be mapped");
});

test("(c) the deliver form prefills the claim's own material — linked PR first, existing bundle on re-delivery", () => {
  const linked = claimDeliverForm(criteriaClaim({ pullRequest: { url: "https://github.com/o/r/pull/7" } }));
  assert.match(linked, /data-claim-deliver="wc_c"/);
  assert.match(linked, /value="https:\/\/github\.com\/o\/r\/pull\/7"/, "the linked PR prefills the artifact ref");
  const existing = claimDeliverForm(criteriaClaim({ delivery: kernelDelivery, deliveryGeneration: 1 }));
  assert.match(existing, /value="https:\/\/example\.com\/results\/wc_b"/, "re-delivery reuses the stored bundle's artifact");
  assert.match(existing, new RegExp(`value="${SHA}"`), "…and its sha256");
  assert.match(existing, /value="unit tests"/, "…and its checks");
});

test("(c) the board offers the holder a deliver form under a reviewed policy, not the bare button", () => {
  const html = render([criteriaClaim()], worker);
  assert.match(html, /data-claim-deliver="wc_c"/, "the deliver form renders on the holder's card");
  assert.doesNotMatch(html, /data-claim-action="deliver"/, "the bundle-less button is gone");
  assert.doesNotMatch(html, /data-claim-action="done"/, "done would still be refused work_not_delivered");
  const selfAttested = render([claim("wc_c")], worker);
  assert.match(selfAttested, /data-claim-action="done"/, "self-attested keeps the single-step finish");
  assert.doesNotMatch(selfAttested, /data-claim-deliver/, "…and gains no form");
});
