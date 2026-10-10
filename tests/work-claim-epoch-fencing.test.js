// FIX-20 (WAVE-300): epoch fencing on work claims.
//
// Every claim carries a server-side `epoch` (non-negative integer, old rows
// decode as 0). Any reap/expiry path that releases a claim to a new holder
// (lease-expiry sweep, release, reassign) bumps epoch+1. A mutation
// submission (update/note/renew/complete) carrying a stale epoch
// (expectedEpoch < current) is rejected with 409 `stale_epoch`; the client
// recovers by re-reading the claim and resubmitting with the current epoch.
// On read the epoch is advisory metadata; on write it is enforced.
import test from "node:test";
import assert from "node:assert/strict";
import {
  claimWork, createWork, reassignWork, releaseExpired, releaseWork, renewWork, updateWork,
  assertEpochFence, ClaimError,
} from "../server/work-claims.mjs";

const NOW = Date.parse("2026-10-09T16:00:00.000Z");
const at = offsetMs => NOW + offsetMs;

function heldClaim(id, epoch, overrides = {}) {
  return {
    id, title: id, state: "claimed", owner: "holder-a", history: [],
    claimedAt: new Date(at(0)).toISOString(),
    leaseStartAt: new Date(at(0)).toISOString(),
    leaseExpiresAt: new Date(at(3600 * 1000)).toISOString(),
    epoch, ...overrides,
  };
}

// --- pure machine: the epoch field ---------------------------------------

test("workOf normalizes a missing epoch to 0 (old rows stay valid)", () => {
  const item = createWork({ id: "w1" }, { now: NOW, agentId: "opener" });
  assert.equal(item.epoch, 0);
});

test("workOf rejects a non-integer or negative epoch", () => {
  assert.throws(() => updateWork(heldClaim("w1", -1), "holder-a", { note: "x", now: at(1) }), /epoch/);
  assert.throws(() => updateWork(heldClaim("w1", 1.5), "holder-a", { note: "x", now: at(1) }), /epoch/);
});

test("releaseExpired bumps epoch+1 on a lapsed claim and leaves live claims untouched", () => {
  const lapsed = heldClaim("w1", 2, { leaseExpiresAt: new Date(at(-1000)).toISOString() });
  const live = heldClaim("w2", 2);
  const [released, kept] = releaseExpired([lapsed, live], at(0));
  assert.equal(released.state, "unclaimed");
  assert.equal(released.epoch, 3);
  assert.equal(kept.epoch, 2);
  assert.ok(released.history.some(entry => entry.action === "lease_expired"));
});

test("reassignWork bumps epoch+1 on a held transfer", () => {
  const moved = reassignWork(heldClaim("w1", 2), "holder-a", "holder-b",
    { expectedClaimedAt: new Date(at(0)).toISOString(), expectedHistoryLength: 0, now: at(1) });
  assert.equal(moved.owner, "holder-b");
  assert.equal(moved.epoch, 3);
});

test("updateWork bumps epoch+1 when the claim is released", () => {
  const released = updateWork(heldClaim("w1", 2), "holder-a", { state: "unclaimed", now: at(1) });
  assert.equal(released.owner, null);
  assert.equal(released.epoch, 3);
});

test("updateWork keeps the epoch on ordinary note/state writes", () => {
  const noted = updateWork(heldClaim("w1", 2), "holder-a", { note: "progress", now: at(1) });
  assert.equal(noted.epoch, 2);
});

test("a fresh claim keeps the item epoch (monotonic — no reset on re-claim)", () => {
  const reclaimed = claimWork({ id: "w1", title: "w1", state: "unclaimed", owner: null, history: [], epoch: 3 }, "holder-a", { now: at(1) });
  assert.equal(reclaimed.epoch, 3);
});

// --- pure machine: the fence -----------------------------------------------

test("assertEpochFence rejects a stale epoch and passes the current one", () => {
  const item = heldClaim("w1", 3);
  assert.throws(() => assertEpochFence(item, 2), error => {
    assert.ok(error instanceof ClaimError);
    assert.equal(error.code, "stale_epoch");
    return true;
  });
  assert.doesNotThrow(() => assertEpochFence(item, 3));
  assert.doesNotThrow(() => assertEpochFence(item, undefined)); // opt-in: absent is legacy behavior
  assert.throws(() => assertEpochFence(item, -1), /expectedEpoch/);
  assert.throws(() => assertEpochFence(item, 1.5), /expectedEpoch/);
});

// --- HTTP: the partitioned-agent scenario -----------------------------------
// Agent A holds the claim at epoch 2. The lease lapses; the sweep reaps it
// (epoch -> 3). A re-claims while partitioned. A's in-flight submission
// prepared before the reap (expectedEpoch 2) is rejected with 409
// stale_epoch; after re-reading (epoch 3) the same write is accepted.
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, displayName, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName, kind: "agent", permissions }
  });
  add("agent-a", "Agent A", ["accept_work", "complete_work"]);
  add("agent-b", "Agent B", ["accept_work", "complete_work"]);
  const keyA = store.issueAccessKey("commons", "agent-a");
  const keyB = store.issueAccessKey("commons", "agent-b");
  const server = createRoomServer({ store, fetchPullRequest: async () => { throw new Error("no github in test"); }, githubToken: "test-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path, body) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  return { store, call, keyA, keyB };
}

async function reapAndReclaim(f, id) {
  // Force the lease to lapse, sweep it on an ordinary request, re-claim.
  const item = f.store.workClaims.get("commons", id);
  f.store.workClaims.set("commons", { ...item, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const swept = await f.call(f.keyA, `/work-claims/${id}`);
  assert.equal(swept.value.epoch, item.epoch + 1, "the sweep bumps the epoch");
  assert.equal(swept.value.owner, null);
  const claimed = await f.call(f.keyA, `/work-claims/${id}/claim`, {});
  assert.equal(claimed.status, 200);
  return claimed.value.epoch;
}

test("partitioned agent: stale-epoch write rejected, re-read resubmit accepted", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.keyA, "/work-claims", { id: "fx20-1", title: "epoch fence" })).status, 201);
  assert.equal((await f.call(f.keyA, "/work-claims/fx20-1/claim", {})).status, 200);
  // Drive the epoch to 2 with two held transfers (reassign bumps epoch+1).
  const read = () => f.call(f.keyA, "/work-claims/fx20-1").then(r => r.value);
  assert.equal((await read()).epoch, 0, "clients learn the epoch from GET work-claims");
  const r1 = await f.call(f.keyA, "/work-claims/fx20-1/reassign",
    { newOwner: "agent-b", expectedClaimedAt: (await read()).claimedAt, expectedHistoryLength: (await read()).history.length });
  assert.equal(r1.status, 200);
  assert.equal(r1.value.epoch, 1);
  const r2 = await f.call(f.keyB, "/work-claims/fx20-1/reassign",
    { newOwner: "agent-a", expectedClaimedAt: r1.value.claimedAt, expectedHistoryLength: r1.value.history.length });
  assert.equal(r2.status, 200);
  assert.equal(r2.value.epoch, 2, "agent A holds the claim at epoch 2");
  // The reap: lease lapses, sweep releases (epoch -> 3), A re-claims.
  const current = await reapAndReclaim(f, "fx20-1");
  assert.equal(current, 3);
  // A's in-flight write from before the reap carries the stale epoch.
  const stale = await f.call(f.keyA, "/work-claims/fx20-1/update", { note: "stale write", expectedEpoch: 2 });
  assert.equal(stale.status, 409);
  assert.equal(stale.value.error.code, "stale_epoch");
  // A re-reads, resubmits with the current epoch: accepted.
  assert.equal((await read()).epoch, 3);
  const fresh = await f.call(f.keyA, "/work-claims/fx20-1/update", { note: "fresh write", expectedEpoch: 3 });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.value.epoch, 3);
  // complete (state=done on update) is fenced the same way.
  const staleDone = await f.call(f.keyA, "/work-claims/fx20-1/update", { state: "done", expectedEpoch: 2 });
  assert.equal(staleDone.status, 409);
  assert.equal(staleDone.value.error.code, "stale_epoch");
});

test("renew is fenced the same way", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.keyA, "/work-claims", { id: "fx20-2", title: "renew fence" })).status, 201);
  assert.equal((await f.call(f.keyA, "/work-claims/fx20-2/claim", {})).status, 200);
  const current = await reapAndReclaim(f, "fx20-2");
  const stale = await f.call(f.keyA, "/work-claims/fx20-2/renew", { expectedEpoch: current - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.value.error.code, "stale_epoch");
  const fresh = await f.call(f.keyA, "/work-claims/fx20-2/renew", { expectedEpoch: current });
  assert.equal(fresh.status, 200);
});

test("a write without expectedEpoch keeps the legacy behavior", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.keyA, "/work-claims", { id: "fx20-3", title: "legacy write" })).status, 201);
  assert.equal((await f.call(f.keyA, "/work-claims/fx20-3/claim", {})).status, 200);
  const noted = await f.call(f.keyA, "/work-claims/fx20-3/update", { note: "no epoch given" });
  assert.equal(noted.status, 200);
  const bad = await f.call(f.keyA, "/work-claims/fx20-3/update", { note: "x", expectedEpoch: "two" });
  assert.equal(bad.status, 422);
});
