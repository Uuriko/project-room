// #3545: core work-claim fencing. The claim record carries a monotonic
// claimGeneration, bumped on every round change (claim, reassign, release,
// sweep-release). Write verbs accept expectedClaimGeneration and refuse a
// stale round with work_claim_conflict — including when the same agent
// holds the new round, the case owner identity cannot discriminate. The
// state machine also enforces the lease it issues: a finish attempted
// after lease expiry (before any sweep) is refused claim_lease_lapsed.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork, releaseWork, reassignWork, appendWorkPullRequest,
  releaseExpired, workOf, ClaimError } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);
const T0 = Date.parse("2026-10-15T12:00:00.000Z");
const H = 3600 * 1000;
const PR = "https://github.com/Uuriko/project-room/pull/3545";

test("generation lifecycle: create 0, claim bumps, release bumps, re-claim bumps", () => {
  const created = createWork({ id: "w1" }, { now: T0, agentId: "maker" });
  assert.equal(created.claimGeneration, 0);
  const claimed = claimWork(created, "quill", { now: T0 });
  assert.equal(claimed.claimGeneration, 1);
  // Non-round writes do not move the generation.
  const started = updateWork(claimed, "quill", { state: "in_progress", now: T0 });
  assert.equal(started.claimGeneration, 1);
  const noted = updateWork(started, "quill", { note: "working", now: T0 });
  assert.equal(noted.claimGeneration, 1);
  // A release ends the round.
  const released = releaseWork(noted, "quill", {
    expectedClaimedAt: noted.claimedAt, expectedHistoryLength: noted.history.length + (noted.historyOmitted ?? 0), now: T0 });
  assert.equal(released.state, "unclaimed");
  assert.equal(released.claimGeneration, 2);
  const reclaimed = claimWork(released, "quill", { now: T0 });
  assert.equal(reclaimed.claimGeneration, 3);
});

test("generation lifecycle: reassign and sweep-release bump", () => {
  const claimed = claimWork(createWork({ id: "w1" }, { now: T0, agentId: "maker" }), "quill", { leaseHours: 1, now: T0 });
  const handed = reassignWork(claimed, "quill", "wren", { now: T0 });
  assert.equal(handed.owner, "wren");
  assert.equal(handed.claimGeneration, 2);
  const [swept] = releaseExpired([handed], T0 + 2 * H);
  assert.equal(swept.state, "unclaimed");
  assert.equal(swept.claimGeneration, 3);
});

test("live lease holder finishes with the current generation", () => {
  const claimed = claimWork(createWork({ id: "w1" }, { now: T0, agentId: "maker" }), "quill", { now: T0 });
  const started = updateWork(claimed, "quill", { state: "in_progress", expectedClaimGeneration: 1, now: T0 });
  const done = updateWork(started, "quill", { state: "done", expectedClaimGeneration: 1, now: T0 });
  assert.equal(done.state, "done");
  assert.equal(done.claimGeneration, 1);
});

test("acceptance: claim -> lapse -> sweep-release -> re-claim -> stale finish refused (same agent)", () => {
  const claimed = claimWork(createWork({ id: "w1" }, { now: T0, agentId: "maker" }), "quill", { leaseHours: 1, now: T0 });
  assert.equal(claimed.claimGeneration, 1);
  const started = updateWork(claimed, "quill", { state: "in_progress", now: T0 });
  // The lease lapses; the sweep releases round 1.
  const [swept] = releaseExpired([started], T0 + 2 * H);
  assert.equal(swept.state, "unclaimed");
  // The SAME agent re-claims: identity matches the stale holder exactly.
  const reclaimed = claimWork(swept, "quill", { leaseHours: 1, now: T0 + 2 * H });
  assert.equal(reclaimed.owner, "quill");
  assert.equal(reclaimed.claimGeneration, 3);
  const restarted = updateWork(reclaimed, "quill", { state: "in_progress", now: T0 + 2 * H });
  // A finish prepared against round 1 is refused, and so is a stale note.
  throwsCode(() => updateWork(restarted, "quill", { state: "done", expectedClaimGeneration: 1, now: T0 + 2 * H }), "work_claim_conflict");
  throwsCode(() => updateWork(restarted, "quill", { note: "stale", expectedClaimGeneration: 1, now: T0 + 2 * H }), "work_claim_conflict");
  // The current round's finish lands.
  const done = updateWork(restarted, "quill", { state: "done", expectedClaimGeneration: 3, now: T0 + 2 * H });
  assert.equal(done.state, "done");
});

test("stale generation refused for a different holder of the new round", () => {
  const claimed = claimWork(createWork({ id: "w1" }, { now: T0, agentId: "maker" }), "quill", { leaseHours: 1, now: T0 });
  const [swept] = releaseExpired([claimed], T0 + 2 * H);
  const taken = claimWork(swept, "wren", { leaseHours: 1, now: T0 + 2 * H });
  assert.equal(taken.claimGeneration, 3);
  // Wren holds the live round; a write fenced to round 1 is refused even
  // though Wren passes the owner-identity gate.
  throwsCode(() => updateWork(taken, "wren", { note: "stale", expectedClaimGeneration: 1, now: T0 + 2 * H }), "work_claim_conflict");
});

test("finish after lease expiry, before any sweep, is refused claim_lease_lapsed", () => {
  const claimed = claimWork(createWork({ id: "w1" }, { now: T0, agentId: "maker" }), "quill", { leaseHours: 1, now: T0 });
  const started = updateWork(claimed, "quill", { state: "in_progress", now: T0 });
  throwsCode(() => updateWork(started, "quill", { state: "done", now: T0 + 2 * H }), "claim_lease_lapsed");
  throwsCode(() => updateWork(started, "quill", { note: "still here", now: T0 + 2 * H }), "claim_lease_lapsed");
  throwsCode(() => updateWork(started, "quill", { state: "blocked", now: T0 + 2 * H }), "claim_lease_lapsed");
});

test("release after lease lapse still works, via releaseWork and via updateWork", () => {
  const claimed = claimWork(createWork({ id: "w1" }, { now: T0, agentId: "maker" }), "quill", { leaseHours: 1, now: T0 });
  const started = updateWork(claimed, "quill", { state: "in_progress", now: T0 });
  const released = releaseWork(started, "quill", {
    expectedClaimedAt: started.claimedAt, expectedHistoryLength: started.history.length, now: T0 + 2 * H });
  assert.equal(released.state, "unclaimed");
  assert.equal(released.owner, null);
  // Direct release transition on a fresh lapsed claim.
  const claimed2 = claimWork(createWork({ id: "w2" }, { now: T0, agentId: "maker" }), "quill", { leaseHours: 1, now: T0 });
  const given = updateWork(claimed2, "quill", { state: "unclaimed", now: T0 + 2 * H });
  assert.equal(given.state, "unclaimed");
});

test("generation precondition on releaseWork, reassignWork and appendWorkPullRequest", () => {
  const claimed = claimWork(createWork({ id: "w1" }, { now: T0, agentId: "maker" }), "quill", { now: T0 });
  const basis = { expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length };
  throwsCode(() => releaseWork(claimed, "quill", { ...basis, expectedClaimGeneration: 99, now: T0 }), "work_claim_conflict");
  throwsCode(() => reassignWork(claimed, "quill", "wren", { ...basis, expectedClaimGeneration: 99, now: T0 }), "work_claim_conflict");
  const started = updateWork(claimed, "quill", { state: "in_progress", now: T0 });
  throwsCode(() => appendWorkPullRequest(started, "quill", {
    pullRequest: PR, expectedClaimedAt: started.claimedAt, expectedHistoryLength: started.history.length,
    expectedClaimGeneration: 99, now: T0 }), "work_claim_conflict");
  const linked = appendWorkPullRequest(started, "quill", {
    pullRequest: PR, expectedClaimedAt: started.claimedAt, expectedHistoryLength: started.history.length,
    expectedClaimGeneration: 1, now: T0 });
  assert.equal(linked.pullRequests.length, 1);
  const released = releaseWork(claimed, "quill", { ...basis, expectedClaimGeneration: 1, now: T0 });
  assert.equal(released.state, "unclaimed");
});

test("malformed expectedClaimGeneration is invalid_claim_input, not a silent pass", () => {
  const claimed = claimWork(createWork({ id: "w1" }, { now: T0, agentId: "maker" }), "quill", { now: T0 });
  for (const bad of [-1, 1.5, "1", null, Number.NaN]) {
    throwsCode(() => updateWork(claimed, "quill", { note: "x", expectedClaimGeneration: bad, now: T0 }), "invalid_claim_input");
  }
});

test("legacy rows without claimGeneration read as round 0 and behave as before", () => {
  const legacy = { id: "w1", state: "unclaimed", owner: null, history: [] };
  assert.equal(workOf(legacy).claimGeneration, 0);
  const claimed = claimWork(legacy, "quill", { now: T0 });
  assert.equal(claimed.claimGeneration, 1);
  // No generation presented: the pre-fencing call contract is unchanged.
  const done = updateWork(updateWork(claimed, "quill", { state: "in_progress", now: T0 }), "quill", { state: "done", now: T0 });
  assert.equal(done.state, "done");
});

// --- Route level: the generation rides claim responses and the update
// precondition refuses a stale one with the same 409 contract as the
// claimedAt + historyLength basis.
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

test("routes: claim response carries claimGeneration; stale generation update is 409", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "task" });
  const claimed = await call(registry, "worker", "claim", "task", {});
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.claimGeneration, 1);
  const fresh = await call(registry, "worker", "update", "task", { note: "v1", expectedClaimGeneration: 1 });
  assert.equal(fresh.status, 200);
  const stale = await call(registry, "worker", "update", "task", { note: "stale", expectedClaimGeneration: 99 });
  assert.equal(stale.status, 409);
  assert.equal(stale.value.error.code, "work_claim_conflict");
  await assert.rejects(call(registry, "worker", "update", "task", { note: "x", expectedClaimGeneration: -1 }),
    error => error.status === 422 && error.code === "invalid_claim_input");
});

test("routes: release with a stale generation is 409; with the current one it lands", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "task" });
  const claimed = (await call(registry, "worker", "claim", "task", {})).value;
  const basis = { expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length };
  await assert.rejects(call(registry, "worker", "release", "task", { ...basis, expectedClaimGeneration: 99 }),
    error => error.status === 409 && error.code === "work_claim_conflict");
  const released = await call(registry, "worker", "release", "task", { ...basis, expectedClaimGeneration: 1 });
  assert.equal(released.status, 200);
  assert.equal(released.value.state, "unclaimed");
  assert.equal(released.value.claimGeneration, 2);
});
