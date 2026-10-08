// FIX-5: compare-and-release on the release route.
//
// Contract under test: POST .../work-claims/{id}/release accepts optional
// `expectedClaimedAt` / `expectedHistoryLength`. When provided, the release
// only proceeds if the claim's current round timestamp and history length
// still match the caller's basis; a mismatch is 409 work_claim_conflict
// ("stale basis") and the live claim is untouched. Omitting both keeps the
// historical behavior.
//
// What this kills (E5): a stale duplicate release from a previous ownership
// round silently destroying a fresh re-claim. The basis check runs on the
// freshly loaded item BEFORE any mutation (including the W2 in_progress
// pause step), so the retried release cannot land on a claim it never read.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { claimHistoryLength } from "../server/work-claims.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";

const fakeHelpers = () => {
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  return { json: (res, status, value) => ({ status, value }), reject, body: async req => req.body };
};

const makeStore = () => {
  const db = new DatabaseSync(":memory:");
  ensureAutonomyTiersSchema(db);
  let nowMs = Date.parse("2026-10-08T19:00:00.000Z");
  return {
    db,
    now: () => (nowMs += 1000),
    roomAuthority: () => ({ ownerId: null, members: {
      quill: { id: "quill", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
    } }),
    // Archived room state makes the event journal early-exit; the claim
    // registry write still commits (same trick as the requestid tests).
    room: () => ({ sequence: 1, state: { messages: [], room: { archivedAt: "2026-01-01T00:00:00.000Z" } } }),
  };
};

const runRoute = async ({ route, id, body = {}, memberId = "quill", registry, store }) => {
  const helpers = fakeHelpers();
  try {
    const out = await handleWorkClaims({ req: { method: "POST", body }, res: {},
      url: {}, store, roomId: "room1", auth: { member: { id: memberId, kind: "agent", permissions: [] } },
      workClaimRoute: route, workClaimId: id, helpers, registry });
    return { out, error: null };
  } catch (error) {
    return { out: null, error };
  }
};

const freshClaimed = async () => {
  const store = makeStore();
  const registry = createWorkClaimRegistry();
  let r = await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry, store });
  assert.equal(r.error, null);
  r = await runRoute({ route: "claim", id: "w1", body: { leaseHours: 6 }, registry, store });
  assert.equal(r.error, null);
  return { store, registry, claimed: r.out.value };
};

const basisOf = item => ({ expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item) });

test("E5: stale duplicate release with an outdated expectedClaimedAt is 409 and the fresh re-claim survives", async () => {
  const { store, registry, claimed } = await freshClaimed();
  const staleBasis = basisOf(claimed);
  // Round 1 ends, round 2 starts: same owner, new round timestamp.
  let r = await runRoute({ route: "release", id: "w1", body: { reason: "round 1 done" }, registry, store });
  assert.equal(r.error, null);
  r = await runRoute({ route: "claim", id: "w1", body: { leaseHours: 6 }, registry, store });
  assert.equal(r.error, null);
  const fresh = r.out.value;
  assert.notEqual(fresh.claimedAt, staleBasis.expectedClaimedAt, "re-claim must start a new round");
  // The old holder's retried release carries the round-1 basis.
  r = await runRoute({ route: "release", id: "w1", body: { reason: "stale retry", ...staleBasis }, registry, store });
  assert.ok(r.error, "stale-basis release must not succeed");
  assert.equal(r.error.status, 409);
  assert.equal(r.error.code, "work_claim_conflict");
  // The fresh re-claim survives untouched.
  const current = registry.get("room1", "w1");
  assert.equal(current.state, "claimed");
  assert.equal(current.owner, "quill");
  assert.equal(current.claimedAt, fresh.claimedAt);
});

test("release with a matching expected basis succeeds exactly as before", async () => {
  const { store, registry, claimed } = await freshClaimed();
  const r = await runRoute({ route: "release", id: "w1", body: { reason: "done", ...basisOf(claimed) }, registry, store });
  assert.equal(r.error, null);
  assert.equal(r.out.status, 200);
  assert.equal(r.out.value.state, "unclaimed");
  assert.equal(r.out.value.owner, null);
});

test("release without the optional basis params behaves as before", async () => {
  const { store, registry } = await freshClaimed();
  const r = await runRoute({ route: "release", id: "w1", body: { reason: "done" }, registry, store });
  assert.equal(r.error, null);
  assert.equal(r.out.status, 200);
  assert.equal(r.out.value.state, "unclaimed");
  assert.equal(r.out.value.owner, null);
});

test("release with only a stale expectedHistoryLength is 409", async () => {
  const { store, registry, claimed } = await freshClaimed();
  const staleLength = claimHistoryLength(claimed);
  // A concurrent edit (note) grows history without changing the round.
  let r = await runRoute({ route: "update", id: "w1", body: { note: "progress" }, registry, store });
  assert.equal(r.error, null);
  r = await runRoute({ route: "release", id: "w1",
    body: { reason: "stale", expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: staleLength }, registry, store });
  assert.ok(r.error, "stale history-length basis must not succeed");
  assert.equal(r.error.status, 409);
  assert.equal(r.error.code, "work_claim_conflict");
  assert.equal(registry.get("room1", "w1").state, "claimed");
});

test("stale basis is checked before the in_progress pause step runs", async () => {
  const { store, registry, claimed } = await freshClaimed();
  const staleBasis = basisOf(claimed);
  let r = await runRoute({ route: "update", id: "w1", body: { state: "in_progress" }, registry, store });
  assert.equal(r.error, null);
  const historyBefore = claimHistoryLength(registry.get("room1", "w1"));
  // The basis predates the state transition: the release must refuse without
  // pausing the claim first (no extra history entries, state untouched).
  r = await runRoute({ route: "release", id: "w1", body: { reason: "stale", ...staleBasis }, registry, store });
  assert.ok(r.error, "stale-basis release must not succeed");
  assert.equal(r.error.status, 409);
  assert.equal(r.error.code, "work_claim_conflict");
  const current = registry.get("room1", "w1");
  assert.equal(current.state, "in_progress");
  assert.equal(claimHistoryLength(current), historyBefore, "no pause step was stamped");
});

test("malformed basis params are 422 invalid_claim_input", async () => {
  const { store, registry } = await freshClaimed();
  for (const bad of [
    { expectedClaimedAt: "not-a-date" },
    { expectedClaimedAt: null },
    { expectedHistoryLength: -1 },
    { expectedHistoryLength: "2" },
  ]) {
    const r = await runRoute({ route: "release", id: "w1", body: { reason: "x", ...bad }, registry, store });
    assert.ok(r.error, `basis ${JSON.stringify(bad)} must be refused`);
    assert.equal(r.error.status, 422, `basis ${JSON.stringify(bad)}`);
    assert.equal(r.error.code, "invalid_claim_input", `basis ${JSON.stringify(bad)}`);
  }
  // All four refusals happened before any mutation: the claim is still live.
  assert.equal(registry.get("room1", "w1").state, "claimed");
});
