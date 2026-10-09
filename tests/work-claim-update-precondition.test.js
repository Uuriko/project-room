// QA-200 worker-13 (slice C3 / E4 stale update): plain note/state updates are
// round-blind. The appendPullRequest variant of POST update binds its write to
// {expectedClaimedAt, expectedHistoryLength} and 409s work_claim_conflict on a
// stale basis, but the note/state variant accepts NO preconditions at all, so a
// stale client can replay an older note payload and silently clobber a newer
// update. These tests pin the opt-in precondition contract on plain updates:
// stale basis -> 409 work_claim_conflict with a read-back hint, fresh basis ->
// 200, malformed preconditions -> 422 invalid_claim_input, and behavior without
// preconditions unchanged (backward compatible).
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

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

const claimFresh = async registry => {
  await call(registry, "owner", "create", null, { id: "task" });
  const claimed = await call(registry, "worker", "claim", "task", {});
  assert.equal(claimed.status, 200);
  return claimed.value;
};

// Notes are stored on history stamps, not a top-level field.
const lastNote = item => item.history[item.history.length - 1].note;
const basisOf = item => ({ expectedClaimedAt: item.claimedAt, expectedHistoryLength: item.history.length });

test("stale note payload replayed with its v1-era basis is refused, not applied", async () => {
  const registry = createWorkClaimRegistry();
  await claimFresh(registry);
  const v1 = (await call(registry, "worker", "update", "task", { note: "v1" })).value;
  assert.equal(lastNote(v1), "v1");
  const staleBasis = basisOf(v1); // captured before the v2 update lands
  const v2 = await call(registry, "worker", "update", "task", { note: "v2" });
  assert.equal(v2.status, 200);
  assert.equal(lastNote(v2.value), "v2");

  // The stale client replays its v1-era payload. This must 409, not clobber v2.
  const replay = await call(registry, "worker", "update", "task", { note: "v1", ...staleBasis });
  assert.equal(replay.status, 409);
  assert.equal(replay.value.error.code, "work_claim_conflict");
  assert.equal(replay.value.next[0].path, "/api/rooms/room1/work-claims/task");
  assert.equal(lastNote(registry.get("room1", "task")), "v2");
});

test("a fresh basis is accepted and the update lands", async () => {
  const registry = createWorkClaimRegistry();
  await claimFresh(registry);
  const v1 = (await call(registry, "worker", "update", "task", { note: "v1" })).value;
  const fresh = await call(registry, "worker", "update", "task", { note: "v2", ...basisOf(v1) });
  assert.equal(fresh.status, 200);
  assert.equal(lastNote(fresh.value), "v2");
});

test("stale history length alone conflicts even when claimedAt matches", async () => {
  const registry = createWorkClaimRegistry();
  await claimFresh(registry);
  const v1 = (await call(registry, "worker", "update", "task", { note: "v1" })).value;
  await call(registry, "worker", "update", "task", { note: "v2" });
  const staleLength = { expectedClaimedAt: v1.claimedAt, expectedHistoryLength: v1.history.length };
  const replay = await call(registry, "worker", "update", "task", { note: "v3", ...staleLength });
  assert.equal(replay.status, 409);
  assert.equal(replay.value.error.code, "work_claim_conflict");
  assert.equal(lastNote(registry.get("room1", "task")), "v2");
});

test("a claimedAt from a different round conflicts even when history length matches", async () => {
  const registry = createWorkClaimRegistry();
  await claimFresh(registry);
  const v1 = (await call(registry, "worker", "update", "task", { note: "v1" })).value;
  const basis = basisOf(v1);
  const other = await call(registry, "worker", "update", "task", { note: "v1", ...basis, expectedClaimedAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(other.status, 409);
  assert.equal(other.value.error.code, "work_claim_conflict");
});

test("malformed preconditions are 422, not silently accepted", async () => {
  const registry = createWorkClaimRegistry();
  const item = await claimFresh(registry);
  const basis = basisOf(item);
  await assert.rejects(call(registry, "worker", "update", "task", { note: "x", ...basis, expectedClaimedAt: "not-a-date" }),
    error => error.status === 422 && error.code === "invalid_claim_input");
  await assert.rejects(call(registry, "worker", "update", "task", { note: "x", ...basis, expectedHistoryLength: -1 }),
    error => error.status === 422 && error.code === "invalid_claim_input");
  await assert.rejects(call(registry, "worker", "update", "task", { note: "x", ...basis, expectedHistoryLength: 1.5 }),
    error => error.status === 422 && error.code === "invalid_claim_input");
});

test("updates without preconditions behave exactly as before", async () => {
  const registry = createWorkClaimRegistry();
  await claimFresh(registry);
  const updated = await call(registry, "worker", "update", "task", { note: "plain" });
  assert.equal(updated.status, 200);
  assert.equal(lastNote(updated.value), "plain");
  const moved = await call(registry, "worker", "update", "task", { state: "in_progress" });
  assert.equal(moved.status, 200);
  assert.equal(moved.value.state, "in_progress");
});
