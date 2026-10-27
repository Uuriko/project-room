// UT2 05-03 F1: a member holding ONLY the review profile ([verify]) claimed
// work and self-closed it to done — the Board gate checked for ANY work
// profile, never the individual accept_work / complete_work permissions, so
// a verify-only member produced a self-attested receipt for work they were
// invited only to verify. These tests pin the granular contract:
//   claim requires accept_work; completing (update to done/delivered) or
//   closing/cancelling as the holder requires complete_work.
// Refusals keep the Board's existing permission-error shape: 403 with code
// work_claims_not_permitted and a message naming the missing permission.
// The reviewer's verify-to-done on a delivered item is a review action, not
// the holder completing their own work, and keeps its verify gate.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  reviewer: { id: "reviewer", kind: "agent", active: true, permissions: ["verify"] },
  accepter: { id: "accepter", kind: "agent", active: true, permissions: ["accept_work"] },
  completer: { id: "completer", kind: "agent", active: true, permissions: ["complete_work"] },
  contributor: { id: "contributor", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.body = { error: { code, message } };
    throw error;
  },
  body: async req => req.body,
};

const call = (registry, memberId, route, id, body) => handleWorkClaims({
  req: { method: "POST", body },
  res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

const refusedFor = (result, permission) => {
  assert.equal(result.status, 403, JSON.stringify(result.value));
  assert.equal(result.value.error.code, "work_claims_not_permitted");
  assert.match(result.value.error.message, new RegExp(permission), "refusal names the missing permission");
};

test("F1 repro: a verify-only member cannot claim work", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "probe-s2" })).status, 201);
  refusedFor(await call(registry, "reviewer", "claim", "probe-s2", {}), "accept_work");
  assert.equal(registry.get("room1", "probe-s2").state, "unclaimed");
  assert.equal(registry.get("room1", "probe-s2").owner, null);
});

test("F1 repro: a verify-only holder cannot self-close to done or close/cancel", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "probe-s2-close" })).status, 201);
  // Hand the item to the reviewer the way the 05-03 battery did (owner
  // reassign); the holder path is what self-attestation abuses.
  const created = registry.get("room1", "probe-s2-close");
  await call(registry, "owner", "reassign", "probe-s2-close", {
    newOwner: "reviewer", expectedClaimedAt: created.claimedAt ?? null, expectedHistoryLength: created.history.length,
  });
  // The 05-03 battery's middle step: starting the held work is a plain
  // holder update under the profile gate and still lands — the harm is
  // the self-attested completion, which is what must now refuse.
  const started = await call(registry, "reviewer", "update", "probe-s2-close", { state: "in_progress" });
  assert.equal(started.status, 200, JSON.stringify(started.value));
  refusedFor(await call(registry, "reviewer", "update", "probe-s2-close", { state: "done" }), "complete_work");
  refusedFor(await call(registry, "reviewer", "close", "probe-s2-close", {}), "complete_work");
  refusedFor(await call(registry, "reviewer", "cancel", "probe-s2-close", {}), "complete_work");
  assert.notEqual(registry.get("room1", "probe-s2-close").state, "done");
});

test("accept_work alone claims and starts, but cannot complete or close", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "accept-only" })).status, 201);
  const claimed = await call(registry, "accepter", "claim", "accept-only", {});
  assert.equal(claimed.status, 200, JSON.stringify(claimed.value));
  assert.equal((await call(registry, "accepter", "update", "accept-only", { state: "in_progress" })).status, 200);
  refusedFor(await call(registry, "accepter", "update", "accept-only", { state: "done" }), "complete_work");
  refusedFor(await call(registry, "accepter", "update", "accept-only", { state: "delivered" }), "complete_work");
  refusedFor(await call(registry, "accepter", "close", "accept-only", {}), "complete_work");
  assert.equal(registry.get("room1", "accept-only").state, "in_progress");
});

test("complete_work alone cannot claim, but a completer holder can finish", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "complete-only" })).status, 201);
  refusedFor(await call(registry, "completer", "claim", "complete-only", {}), "accept_work");
  const created = registry.get("room1", "complete-only");
  await call(registry, "owner", "reassign", "complete-only", {
    newOwner: "completer", expectedClaimedAt: created.claimedAt ?? null, expectedHistoryLength: created.history.length,
  });
  assert.equal((await call(registry, "completer", "update", "complete-only", { state: "in_progress" })).status, 200);
  const done = await call(registry, "completer", "update", "complete-only", { state: "done" });
  assert.equal(done.status, 200, JSON.stringify(done.value));
  assert.equal(done.value.state, "done");
});

test("create with an assignee is a claim: the assignee needs accept_work", async () => {
  const registry = createWorkClaimRegistry();
  refusedFor(await call(registry, "owner", "create", null, { id: "assign-review", assignee: "reviewer" }), "accept_work");
  assert.equal(registry.has("room1", "assign-review"), false);
  const assigned = await call(registry, "owner", "create", null, { id: "assign-contrib", assignee: "contributor" });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.value));
  assert.equal(assigned.value.owner, "contributor");
});

test("contributor lifecycle is unchanged: claim, start, done", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "full" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "full", {})).status, 200);
  assert.equal((await call(registry, "contributor", "update", "full", { state: "in_progress" })).status, 200);
  const done = await call(registry, "contributor", "update", "full", { state: "done" });
  assert.equal(done.status, 200, JSON.stringify(done.value));
  assert.equal(done.value.state, "done");
});

test("a holder with both permissions can close their own claim", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "closable" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "closable", {})).status, 200);
  const closed = await call(registry, "contributor", "close", "closable", {});
  assert.equal(closed.status, 200, JSON.stringify(closed.value));
});

test("the reviewer's verify-to-done on delivered work keeps the verify gate, not complete_work", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "reviewed", reviewPolicy: "distinct_member" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "reviewed", {})).status, 200);
  assert.equal((await call(registry, "contributor", "update", "reviewed", { state: "in_progress" })).status, 200);
  const delivered = await call(registry, "contributor", "update", "reviewed", {
    state: "delivered",
    delivery: { artifact: { kind: "text", ref: "room://artifacts/x", sha256: "c".repeat(64) }, checks: [{ name: "unit", result: "pass" }], criteria: [] },
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.value));
  const review = await call(registry, "reviewer", "review", "reviewed", { verdict: "approve", summary: "Verified." });
  assert.equal(review.status, 200, JSON.stringify(review.value));
  const done = await call(registry, "reviewer", "update", "reviewed", { state: "done" });
  assert.equal(done.status, 200, JSON.stringify(done.value));
  assert.equal(done.value.state, "done");
});
