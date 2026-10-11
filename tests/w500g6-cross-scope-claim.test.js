// WAVE-500 guild 6 (room API): fail-first repros for the #2536 review
// blocker "duplicate active deliveries" — claimWakeBatch lets a listener
// claim signals already claimed under a LIVE lease held by another
// listener/scope. The module's own contract says a claim is abandoned only
// when its fencing token no longer holds a live lease; the claim SELECT
// reclaims any claim by a different token without checking that.
//
// These tests MUST FAIL on main (the cross-scope steal is accepted) and
// pass once the claim path refuses foreign live-held batches.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const AGENT = "w500_x";
const ROOM_ONE = "room-one";

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  t.after(() => db.close());
  return { hb: new AgentHeartbeats({ db, now: () => at }, {}) };
}

function registered(hb) {
  hb.heartbeat({ agentId: AGENT, hostId: "host-1", mode: "pull-only" });
}

function enqueueTwo(hb) {
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM_ONE, messageId: "w500-m1" });
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM_ONE, messageId: "w500-m2" });
}

const staleListener = err =>
  err instanceof HeartbeatError && err.status === 409 && err.code === "stale_listener";

test("cross-scope claim: a global-scope listener must not re-claim a room lease's live unacked batch", t => {
  const { hb } = unit(t);
  registered(hb);
  enqueueTwo(hb);
  // Lease A: (agent, room-one) holds a live lease and claims both signals.
  const leaseA = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM_ONE, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(leaseA.acquired, true);
  const batchA = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM_ONE, fencingToken: leaseA.fencingToken, limit: 5 });
  assert.equal(batchA.signals.length, 2, "lease A claims the batch");
  assert.deepEqual(batchA.signals.map(s => s.redelivered), [false, false]);
  // The lease is still live and the signals are still unacked.
  const renewed = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM_ONE, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(renewed.renewed, true, "lease A is still live");
  assert.equal(renewed.fencingToken, leaseA.fencingToken);
  assert.equal(hb.pendingWakes(AGENT, { roomId: ROOM_ONE }).length, 2, "claimed signals stay unacked until ackWakes");
  // Lease B: a different listener takes the overlapping global scope.
  const leaseB = hb.acquireListenerLease({ agentId: AGENT, roomId: null, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(leaseB.acquired, true, "the global scope is a separate lease key, so it is granted");
  // B's fencing token holds no live lease over room-one's signals: the
  // steal must be refused with 409 stale_listener, not delivered twice.
  assert.throws(
    () => hb.claimWakeBatch({ agentId: AGENT, roomId: null, fencingToken: leaseB.fencingToken, limit: 5 }),
    staleListener,
    "cross-scope claim accepted a stale token where 409 stale_listener was expected",
  );
});

test("cross-scope claim (reverse): a room-scoped listener must not re-claim a global lease's live unacked batch", t => {
  const { hb } = unit(t);
  registered(hb);
  enqueueTwo(hb);
  // Lease A: global scope (agent, room_key '') claims both signals.
  const leaseA = hb.acquireListenerLease({ agentId: AGENT, roomId: null, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(leaseA.acquired, true);
  const batchA = hb.claimWakeBatch({ agentId: AGENT, roomId: null, fencingToken: leaseA.fencingToken, limit: 5 });
  assert.equal(batchA.signals.length, 2, "global lease A claims the batch");
  const renewed = hb.acquireListenerLease({ agentId: AGENT, roomId: null, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(renewed.renewed, true, "lease A is still live");
  assert.equal(hb.pendingWakes(AGENT, { roomId: ROOM_ONE }).length, 2, "claimed signals stay unacked until ackWakes");
  // Lease B: a different listener takes the overlapping room-one scope.
  const leaseB = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM_ONE, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(leaseB.acquired, true, "room-one is a separate lease key, so it is granted");
  // B's token is stale with respect to these signals — lease A still holds
  // them under a live lease. 409 stale_listener, not a second delivery.
  assert.throws(
    () => hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM_ONE, fencingToken: leaseB.fencingToken, limit: 5 }),
    staleListener,
    "cross-scope claim accepted a stale token where 409 stale_listener was expected",
  );
});
