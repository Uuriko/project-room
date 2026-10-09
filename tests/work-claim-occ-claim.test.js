// FIX-72 (WAVE-300 ranked-fixes burn-down): generalize optimistic concurrency
// control to the claim path and validate dependsOn liveness.
//
// The update path (and, via FIX-5, release) binds writes to
// {expectedClaimedAt, expectedHistoryLength} and 409s work_claim_conflict on
// a stale basis — but the claim route accepted no preconditions, so a stale
// client could claim an item whose round had already turned over (a silent
// re-claim of a changed round). And dependsOn was only checked for
// existence: depending on a released/expired/closed claim accepted 200
// silently (COLLIDE-5 E2b). These tests pin the new contracts:
//   - stale claim basis -> 409 work_claim_conflict, never a silent claim;
//   - fresh claim basis -> 200; malformed preconditions -> 422
//     invalid_claim_input; no preconditions -> legacy behavior;
//   - dependsOn a released/expired/closed claim -> 422 naming the dead dep;
//   - dependsOn healthy claims (active, done, never-claimed) -> 200.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { assertDependsOnLive } from "../server/work-claim-integrity.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  worker: { id: "worker", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const call = (registry, memberId, route, id, body, query = "") => handleWorkClaims({
  req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${query}`),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

// The read basis a client echoes back: claimedAt is null on an unclaimed item.
const basisOf = item => ({ expectedClaimedAt: item.claimedAt, expectedHistoryLength: item.history.length });

const created = async (registry, id, body = {}) => {
  const result = await call(registry, "owner", "create", null, { id, ...body });
  assert.equal(result.status, 201, `create ${id} should succeed`);
  return result.value;
};

// ---------------------------------------------------------------------------
// (a) OCC preconditions on the claim route
// ---------------------------------------------------------------------------

test("a stale claim basis is refused with 409 work_claim_conflict, not a silent re-claim", async () => {
  const registry = createWorkClaimRegistry();
  await created(registry, "task");
  const staleBasis = basisOf(registry.get("room1", "task"));
  assert.deepEqual(staleBasis, { expectedClaimedAt: null, expectedHistoryLength: 1 });
  // Another round turns the item over: claim, then release.
  assert.equal((await call(registry, "worker", "claim", "task", {})).status, 200);
  const held = registry.get("room1", "task");
  assert.equal((await call(registry, "worker", "release", "task", basisOf(held))).status, 200);
  assert.equal(registry.get("room1", "task").state, "unclaimed");
  // The stale client retries its claim with the pre-round basis.
  const retry = await call(registry, "worker", "claim", "task", staleBasis);
  assert.equal(retry.status, 409);
  assert.equal(retry.value.error.code, "work_claim_conflict");
  assert.match(retry.value.error.message, /stale/i);
  assert.ok(retry.value.hint, "the refusal carries a read-back hint");
  assert.equal(registry.get("room1", "task").state, "unclaimed", "the stale claim must not land");
  assert.equal(registry.get("room1", "task").owner, null);
});

test("a stale history length alone conflicts even when claimedAt matches", async () => {
  const registry = createWorkClaimRegistry();
  await created(registry, "task");
  assert.equal((await call(registry, "worker", "claim", "task", {})).status, 200);
  // A note-only update grows the history without touching claimedAt.
  const noted = await call(registry, "worker", "update", "task", { note: "bump" });
  assert.equal(noted.status, 200);
  const claimed = registry.get("room1", "task");
  const stale = { expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length - 1 };
  await call(registry, "worker", "release", "task", basisOf(claimed));
  const retry = await call(registry, "worker", "claim", "task", stale);
  assert.equal(retry.status, 409);
  assert.equal(retry.value.error.code, "work_claim_conflict");
});

test("a fresh claim basis is accepted", async () => {
  const registry = createWorkClaimRegistry();
  await created(registry, "task");
  const basis = basisOf(registry.get("room1", "task"));
  const claimed = await call(registry, "worker", "claim", "task", basis);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.state, "claimed");
  assert.equal(claimed.value.owner, "worker");
});

test("malformed claim preconditions are 422 invalid_claim_input, never silently accepted", async () => {
  for (const bad of [
    { expectedClaimedAt: 123, expectedHistoryLength: 1 },
    { expectedClaimedAt: "not-a-date", expectedHistoryLength: 1 },
    { expectedClaimedAt: null, expectedHistoryLength: -1 },
    { expectedClaimedAt: null, expectedHistoryLength: 1.5 },
    { expectedClaimedAt: null }, // half a basis is malformed (mirrors the update route)
    { expectedHistoryLength: 1 },
  ]) {
    const registry = createWorkClaimRegistry();
    await created(registry, "task");
    await assert.rejects(call(registry, "worker", "claim", "task", bad),
      error => error.status === 422 && error.code === "invalid_claim_input", `basis ${JSON.stringify(bad)}`);
    assert.equal(registry.get("room1", "task").state, "unclaimed", "the malformed claim must not land");
  }
});

test("claims without preconditions behave exactly as before", async () => {
  const registry = createWorkClaimRegistry();
  await created(registry, "task");
  const claimed = await call(registry, "worker", "claim", "task", { note: "plain" });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.state, "claimed");
});

// ---------------------------------------------------------------------------
// (b) dependsOn liveness on the claim route
// ---------------------------------------------------------------------------

const releaseDep = async (registry, id) => {
  assert.equal((await call(registry, "worker", "claim", id, {})).status, 200);
  const held = registry.get("room1", id);
  assert.equal((await call(registry, "worker", "release", id, basisOf(held))).status, 200);
  const dep = registry.get("room1", id);
  assert.equal(dep.state, "unclaimed");
  assert.ok(dep.claimedAt !== null, "a released item keeps its round timestamp");
};

test("claiming with dependsOn a released claim is 422 naming the dead dependency", async () => {
  const registry = createWorkClaimRegistry();
  await created(registry, "dep");
  await releaseDep(registry, "dep");
  await created(registry, "task");
  await assert.rejects(call(registry, "worker", "claim", "task", { dependsOn: ["dep"] }),
    error => error.status === 422 && error.code === "invalid_claim_input"
      && /dependsOn/.test(error.message) && /"dep"/.test(error.message) && /released/i.test(error.message));
  assert.equal(registry.get("room1", "task").state, "unclaimed", "the claim must not land");
});

test("claiming with dependsOn a closed claim is 422 naming the dead dependency", async () => {
  const registry = createWorkClaimRegistry();
  await created(registry, "dep");
  assert.equal((await call(registry, "owner", "close", "dep", { reason: "stale" })).status, 200);
  assert.equal(registry.get("room1", "dep").state, "closed");
  await created(registry, "task");
  await assert.rejects(call(registry, "worker", "claim", "task", { dependsOn: ["dep"] }),
    error => error.status === 422 && error.code === "invalid_claim_input"
      && /dependsOn/.test(error.message) && /"dep"/.test(error.message) && /closed/i.test(error.message));
  assert.equal(registry.get("room1", "task").state, "unclaimed", "the claim must not land");
});

test("claiming with dependsOn a lease-expired claim is 422 naming the dead dependency", async () => {
  const registry = createWorkClaimRegistry();
  await created(registry, "dep");
  assert.equal((await call(registry, "worker", "claim", "dep", {})).status, 200);
  // Let the lease lapse without waiting: forge a past expiry on the stored item.
  const dep = registry.get("room1", "dep");
  registry.set("room1", { ...dep, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(registry.get("room1", "dep").state, "claimed");
  await created(registry, "task");
  // The route sweeps lapsed leases before the claim runs, so the dependency
  // arrives released (stamped lease_expired); either way it must 422 by name.
  await assert.rejects(call(registry, "worker", "claim", "task", { dependsOn: ["dep"] }),
    error => error.status === 422 && error.code === "invalid_claim_input"
      && /dependsOn/.test(error.message) && /"dep"/.test(error.message) && /released|expired/i.test(error.message));
  assert.ok(registry.get("room1", "dep").history.some(entry => entry.action === "lease_expired"),
    "the lapsed lease is swept with a lease_expired stamp");
  assert.equal(registry.get("room1", "task").state, "unclaimed", "the claim must not land");
});

test("claiming with dependsOn healthy claims still works: active, done, and never-claimed", async () => {
  const registry = createWorkClaimRegistry();
  await created(registry, "dep-active");
  await created(registry, "dep-done");
  await created(registry, "dep-fresh");
  assert.equal((await call(registry, "worker", "claim", "dep-active", {})).status, 200);
  assert.equal((await call(registry, "owner", "claim", "dep-done", {})).status, 200);
  assert.equal((await call(registry, "owner", "update", "dep-done", { state: "in_progress" })).status, 200);
  assert.equal((await call(registry, "owner", "update", "dep-done", { state: "done" })).status, 200);
  assert.equal(registry.get("room1", "dep-done").state, "done");

  await created(registry, "t1");
  await created(registry, "t2");
  await created(registry, "t3");
  for (const [id, dep] of [["t1", "dep-active"], ["t2", "dep-done"], ["t3", "dep-fresh"]]) {
    const claimed = await call(registry, "worker", "claim", id, { dependsOn: [dep] });
    assert.equal(claimed.status, 200, `claim ${id} depending on ${dep} should succeed`);
    assert.deepEqual(claimed.value.dependsOn, [dep]);
  }
});

// ---------------------------------------------------------------------------
// assertDependsOnLive unit contract
// ---------------------------------------------------------------------------

const liveReject = (status, code, message) => {
  const error = new Error(message); error.status = status; error.code = code; throw error;
};
const live = (data, dep) => assertDependsOnLive(liveReject, data,
  { selfId: "task", get: id => (id === "dep" ? dep : null), nowMs: Date.now() });

test("assertDependsOnLive refuses released, expired, and closed dependencies by name", () => {
  const now = Date.now();
  assert.throws(() => live({ dependsOn: ["dep"] }, { id: "dep", state: "unclaimed", claimedAt: "2026-10-01T00:00:00.000Z", history: [] }),
    /dependsOn:.*"dep".*released/i);
  assert.throws(() => live({ dependsOn: ["dep"] },
    { id: "dep", state: "claimed", claimedAt: "2026-10-08T00:00:00.000Z", leaseExpiresAt: new Date(now - 1000).toISOString(), history: [] }),
    /dependsOn:.*"dep".*expired/i);
  assert.throws(() => live({ dependsOn: ["dep"] }, { id: "dep", state: "closed", history: [] }),
    /dependsOn:.*"dep".*closed/i);
});

test("assertDependsOnLive accepts active, done, and never-claimed dependencies", () => {
  const now = Date.now();
  assert.doesNotThrow(() => live({ dependsOn: ["dep"] },
    { id: "dep", state: "claimed", claimedAt: "2026-10-08T00:00:00.000Z", leaseExpiresAt: new Date(now + 3600_000).toISOString(), history: [] }));
  assert.doesNotThrow(() => live({ dependsOn: ["dep"] }, { id: "dep", state: "done", history: [] }));
  assert.doesNotThrow(() => live({ dependsOn: ["dep"] },
    { id: "dep", state: "unclaimed", claimedAt: null, history: [] }));
  assert.doesNotThrow(() => live({ dependsOn: ["dep"] },
    { id: "dep", state: "claimed", claimedAt: "2026-10-08T00:00:00.000Z", leaseExpiresAt: null, history: [] }),
    "a claim with no lease never expires");
});

test("assertDependsOnLive skips what other guards report: unknown, self, non-string", () => {
  const get = id => (id === "dep" ? { id: "dep", state: "closed", history: [] } : null);
  // Unknown ids are assertDependsOnKnown's job; self-dependence is reported there too.
  assert.doesNotThrow(() => assertDependsOnLive(liveReject, { dependsOn: ["ghost"] }, { selfId: "task", get, nowMs: Date.now() }));
  assert.doesNotThrow(() => assertDependsOnLive(liveReject, { dependsOn: ["task"] }, { selfId: "task", get, nowMs: Date.now() }));
  assert.doesNotThrow(() => assertDependsOnLive(liveReject, { dependsOn: [42] }, { selfId: "task", get, nowMs: Date.now() }));
  assert.doesNotThrow(() => assertDependsOnLive(liveReject, {}, { selfId: "task", get, nowMs: Date.now() }));
});
