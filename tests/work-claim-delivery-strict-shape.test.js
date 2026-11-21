// UT2 candidate 7 (lane 03-05 finding D1, EXECUTED S2): a delivery bundle
// carrying artifact.content (the full artifact text), artifact.surprise and
// a top-level delivery note was ACCEPTED with a 200, and the stored delivery
// contained none of them — the worker saw success and silently lost content.
// The kernel's deliveryOf validator built the stored bundle from named
// fields only, dropping every other key without a word.
//
// Cure: strict shape, mirroring the product's own unknown-field refusals
// (server/http.mjs body(): 422 `unknown fields: <names>`; agent-rooms and
// members-directory name unknown fields the same way). A delivery, its
// artifact, each check entry and each criterion entry refuse unknown fields
// BY NAME with the existing delivery error code (invalid_claim_input, which
// the work-claim routes map to 422 — no new error code).
//
// D2 (artifact.kind is length-only validated; "banana" was stored verbatim)
// is deliberately NOT cured here: no kind vocabulary exists anywhere in the
// product (the closing-rules text shows kind as "..."), so enumerating one
// would invent a taxonomy, not mirror one. See the PR body.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { createWork, claimWork, updateWork, workOf, ClaimError } from "../server/work-claims.mjs";

const SHA = "a".repeat(64);
const BUNDLE = {
  artifact: { kind: "text", ref: "alpha-summary.txt", sha256: SHA },
  checks: [{ name: "unit tests", result: "pass" }],
  criteria: [{ criterion: "criterion A", status: "met" }],
};
const auth = (id, kind, permissions) => ({ member: { id, kind, permissions } });
const OWNER = auth("owner", "human", ["manage_claims"]);
const WORKER = auth("worker", "agent", ["accept_work", "complete_work"]);

async function claimed(t, id) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons",
    { id: "add-worker", type: "member.added", data: { memberId: "worker", displayName: "worker", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, claimId, body, extra = {}) => handleWorkClaims({
    req: { method: "POST", body }, res: {}, url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons", auth: extra.auth ?? OWNER,
    workClaimRoute: route, workClaimId: claimId, helpers, registry: store.workClaims,
  });
  await call("create", null, { id, title: `Task ${id}`, reviewPolicy: "distinct_member", acceptanceCriteria: ["criterion A"] });
  await call("claim", id, { leaseHours: 6 }, { auth: WORKER });
  await call("update", id, { state: "in_progress" }, { auth: WORKER });
  const get = () => store.workClaims.get("commons", id);
  return { call, get };
}

test("route: the evidence bundle (artifact.content, artifact.surprise, delivery note) is refused 422 naming every extra field, and nothing is stored", async t => {
  const r = await claimed(t, "extra-fields");
  const poisoned = {
    artifact: { kind: "text", ref: "alpha-summary.txt", sha256: SHA, content: "the full artifact text", surprise: "x" },
    checks: BUNDLE.checks, criteria: BUNDLE.criteria, note: "extra",
  };
  // Levels refuse outermost-first: the full evidence bundle names its
  // top-level extra; with that removed, the artifact extras are named.
  await assert.rejects(
    r.call("update", "extra-fields", { state: "delivered", delivery: poisoned }, { auth: WORKER }),
    error => error.status === 422 && error.code === "invalid_claim_input" && error.message.includes("note"));
  const { note: _dropped, ...withoutNote } = poisoned;
  await assert.rejects(
    r.call("update", "extra-fields", { state: "delivered", delivery: withoutNote }, { auth: WORKER }),
    error => error.status === 422 && error.code === "invalid_claim_input"
      && error.message.includes("content") && error.message.includes("surprise"));
  // No partial state: the claim is still in progress with no delivery.
  assert.equal(r.get().state, "in_progress");
  assert.equal(r.get().delivery, null);
});

test("route: a top-level unknown delivery field is refused by name even when nested fields are clean", async t => {
  const r = await claimed(t, "extra-top");
  await assert.rejects(
    r.call("update", "extra-top", { state: "delivered", delivery: { ...BUNDLE, note: "extra" } }, { auth: WORKER }),
    error => error.status === 422 && error.code === "invalid_claim_input" && error.message.includes("note"));
  assert.equal(r.get().state, "in_progress");
});

test("route: the clean evidence-shaped bundle (same fields minus the extras) still delivers", async t => {
  const r = await claimed(t, "clean-bundle");
  const delivered = (await r.call("update", "clean-bundle", { state: "delivered", delivery: BUNDLE }, { auth: WORKER })).value;
  assert.equal(delivered.state, "delivered");
  assert.deepEqual(Object.keys(delivered.delivery.artifact).sort(), ["kind", "ref", "sha256"]);
});

const kernelDelivered = (id, delivery) => {
  let item = createWork({ id, title: id, reviewPolicy: "distinct_member", acceptanceCriteria: ["criterion A"] },
    { now: Date.parse("2026-10-27T00:00:00.000Z"), agentId: "poster" });
  item = claimWork(item, "alice", { now: Date.parse("2026-10-27T00:00:00.000Z"), leaseHours: 24 });
  item = updateWork(item, "alice", { state: "in_progress", now: Date.parse("2026-10-27T01:00:00.000Z") });
  return updateWork(item, "alice", { state: "delivered", delivery, now: Date.parse("2026-10-27T02:00:00.000Z") });
};
const throwsNaming = (fn, ...names) => assert.throws(fn,
  error => error instanceof ClaimError && error.code === "invalid_claim_input"
    && names.every(name => error.message.includes(name)));

test("kernel: unknown fields inside a check entry and a criterion entry are refused by name", () => {
  throwsNaming(() => kernelDelivered("k-check", {
    ...BUNDLE, checks: [{ name: "unit tests", result: "pass", output: "log text" }],
  }), "output");
  throwsNaming(() => kernelDelivered("k-criterion", {
    ...BUNDLE, criteria: [{ criterion: "criterion A", status: "met", comment: "looks good" }],
  }), "comment");
});

test("kernel: a stored delivery (bundle + digest/deliveredBy/deliveredAt stamp) still round-trips through workOf", () => {
  const delivered = kernelDelivered("k-roundtrip", BUNDLE);
  assert.equal(delivered.state, "delivered");
  const reread = workOf(delivered);
  assert.equal(reread.delivery.digest, delivered.delivery.digest);
  assert.deepEqual(reread.delivery.artifact, BUNDLE.artifact);
  assert.deepEqual(reread.delivery.checks, BUNDLE.checks);
  assert.deepEqual(reread.delivery.criteria, BUNDLE.criteria);
});
