// Heartbeat contract: silent liveness proofs that never touch the room event
// budget. A heartbeat extends the CURRENT lease window (no new window, no
// leaseSeq change) and writes the row silently — the event budget gate is
// skipped because there is no event to gate (W3 measurement: 200 agents on
// 15-min leases would burn the 10k lifetime budget in ~10h otherwise).
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work"] },
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  other: { id: "other", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const fakeStore = {
  roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }),
  room: () => ({ sequence: 1, state: { messages: [] } }),
};

const call = (registry, memberId, route, id, body) => handleWorkClaims({
  req: { method: "POST", body },
  res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store: fakeStore,
  roomId: "room1",
  auth: { member: { ...MEMBERS[memberId], id: memberId } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

const heldRegistry = async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "w1", files: ["src/w1.mjs"] });
  const claimed = await call(registry, "holder", "claim", "w1", { leaseHours: 1 });
  assert.equal(claimed.status, 200);
  return registry;
};

test("heartbeat extends the current window silently — no room event, no leaseSeq change", async () => {
  const registry = await heldRegistry();
  const before = registry.get("room1", "w1");
  const hb = await call(registry, "holder", "heartbeat", "w1", { leaseSeq: 1, idempotencyKey: "k1" });
  assert.equal(hb.status, 200);
  const after = registry.get("room1", "w1");
  // The window extended from now (leaseStartAt moved), same length.
  assert.ok(Date.parse(after.leaseStartAt) >= Date.parse(before.leaseStartAt));
  assert.equal(Date.parse(after.leaseExpiresAt) - Date.parse(after.leaseStartAt),
    Date.parse(before.leaseExpiresAt) - Date.parse(before.leaseStartAt));
  // No new claim round: leaseSeq untouched, consecutiveHeartbeats incremented.
  assert.equal(after.leaseSeq, 1);
  assert.equal(after.consecutiveHeartbeats, 1);
  assert.ok(after.lastHeartbeatAt);
  // Silent means: the row carries exactly one "heartbeat" stamp. The route
  // writes via registry.set, never via commit/emitWorkClaimEvent, so no
  // work_claim.updated room event is produced (the 10k budget is untouched).
  assert.deepEqual(after.history.map(entry => entry.action),
    [...before.history.map(entry => entry.action), "heartbeat"]);
  // The receipt names the next heartbeat and the grace end.
  assert.ok(hb.value.nextHeartbeatBy);
  assert.ok(hb.value.graceEndsAt);
});

test("heartbeat requires the current leaseSeq — a stale round is 409 claim_lease_stale", async () => {
  const registry = await heldRegistry();
  await assert.rejects(call(registry, "holder", "heartbeat", "w1", { leaseSeq: 99, idempotencyKey: "k2" }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "claim_lease_stale");
    return true;
  });
  // A missing leaseSeq is also rejected (the client must fence).
  await assert.rejects(call(registry, "holder", "heartbeat", "w1", { idempotencyKey: "k3" }), error => {
    assert.equal(error.status, 422);
    return true;
  });
});

test("heartbeat idempotency: a retried key replays the stored receipt with no second write", async () => {
  const registry = await heldRegistry();
  const first = await call(registry, "holder", "heartbeat", "w1", { leaseSeq: 1, idempotencyKey: "retry-me" });
  assert.equal(first.status, 200);
  const afterFirst = registry.get("room1", "w1");
  const second = await call(registry, "holder", "heartbeat", "w1", { leaseSeq: 1, idempotencyKey: "retry-me" });
  assert.equal(second.status, 200);
  assert.deepEqual(second.value, first.value);
  const afterSecond = registry.get("room1", "w1");
  // No second write: consecutiveHeartbeats did not increment again.
  assert.equal(afterSecond.consecutiveHeartbeats, afterFirst.consecutiveHeartbeats);
  assert.equal(afterSecond.lastHeartbeatAt, afterFirst.lastHeartbeatAt);
});

test("anti-squatting: after 3 heartbeats without a renew, heartbeats are refused until a renew", async () => {
  const registry = await heldRegistry();
  for (let i = 1; i <= 3; i += 1) {
    const hb = await call(registry, "holder", "heartbeat", "w1", { leaseSeq: 1, idempotencyKey: `k${i}` });
    assert.equal(hb.status, 200);
  }
  await assert.rejects(call(registry, "holder", "heartbeat", "w1", { leaseSeq: 1, idempotencyKey: "k4" }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "claim_renewal_required");
    return true;
  });
  // A renew with progress resets the counter; heartbeats work again.
  const renewed = await call(registry, "holder", "renew", "w1", { note: "progress: still going" });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.value.consecutiveHeartbeats, 0);
  const hb = await call(registry, "holder", "heartbeat", "w1", { leaseSeq: renewed.value.leaseSeq, idempotencyKey: "k5" });
  assert.equal(hb.status, 200);
});

test("heartbeat inside the grace window restores the pre-expiry state", async () => {
  const registry = await heldRegistry();
  // Move the claim into the expired (grace) state the way the reaper would.
  const item = registry.get("room1", "w1");
  const expiredAt = Date.parse(item.leaseExpiresAt);
  registry.set("room1", { ...item, state: "expired", priorActiveState: "claimed" });
  const hb = await call(registry, "holder", "heartbeat", "w1", { leaseSeq: 1, idempotencyKey: "grace1" });
  assert.equal(hb.status, 200);
  const after = registry.get("room1", "w1");
  assert.equal(after.state, "claimed");
  assert.equal(after.priorActiveState, null);
  assert.ok(Date.parse(after.leaseExpiresAt) > expiredAt);
});

test("heartbeat by a non-owner is refused", async () => {
  const registry = await heldRegistry();
  await assert.rejects(call(registry, "other", "heartbeat", "w1", { leaseSeq: 1, idempotencyKey: "x1" }), error => {
    assert.equal(error.status, 403);
    assert.equal(error.code, "work_not_owner");
    return true;
  });
});
