// WAVE-500 Guild 9 A6 — #2536 remediation: owner-fenced ack/claim.
// Fail-first tests for Dot's 10406/10407 blockers and Tab's 10408/10409 repros:
//   (a) claimWakeBatch binds claimed signals to the claiming lease (owner
//       recorded at claim time);
//   (b) ackWakes refuses acks for signals owned by a different live lease
//       (fencing by actual owner, not just token presence);
//   (c) overlapping scopes never both deliver the same signal;
//   (d) token validation is atomic with the mutation (single statement,
//       no check-then-act).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const ROOM = "muse-room";

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  t.after(() => db.close());
  const hb = new AgentHeartbeats({ db, now: () => at }, {});
  return { db, hb, advance: ms => { at += ms; } };
}

const wakeable = (agentId = "ai_lease", hostId = "host-1") =>
  ({ agentId, hostId, mode: "pull-only" });

function enqueue(hb, agentId, n, roomId = ROOM) {
  for (let i = 0; i < n; i++) hb.enqueueWake({ agentId, kind: "mention", roomId, messageId: `m${i}` });
}

function leases(t) {
  const { db, hb, advance } = unit(t);
  hb.heartbeat(wakeable());
  const room = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "room-listener", ttlMs: 60000 });
  const all = hb.acquireListenerLease({ agentId: "ai_lease", roomId: null, listenerId: "all-listener", ttlMs: 60000 });
  assert.ok(room.acquired && all.acquired, "both scopes hold live leases");
  return { db, hb, advance, room, all };
}

test("claimWakeBatch records the claiming lease (token + scope) on the claim row", t => {
  const { db, hb, room } = leases(t);
  enqueue(hb, "ai_lease", 1);
  const batch = hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: room.fencingToken });
  assert.equal(batch.signals.length, 1);
  const row = db.prepare(
    "SELECT room_key AS roomKey, claimed_by AS claimedBy FROM agent_wake_signal_claims").get();
  assert.equal(row.claimedBy, room.fencingToken, "claim names the claiming lease's fencing token");
  assert.equal(row.roomKey, ROOM, "claim records the claiming lease's scope");
});

test("a second live scope's claim skips signals owned by the first scope", t => {
  const { hb, room, all } = leases(t);
  enqueue(hb, "ai_lease", 1);
  const first = hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: room.fencingToken });
  assert.equal(first.signals.length, 1);
  const second = hb.claimWakeBatch({ agentId: "ai_lease", roomId: null, fencingToken: all.fencingToken });
  assert.equal(second.signals.length, 0, "owned signals are not replayed to a second live scope");
  // And the reverse direction: the room scope cannot steal the all-rooms batch either.
  const third = hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: room.fencingToken });
  assert.equal(third.signals.length, 0, "the owner re-claiming its own batch gets nothing new");
  assert.equal(hb.pendingWakes("ai_lease", { roomId: ROOM }).length, 1, "signal stays queued for its owner");
});

test("ackWakes refuses acks for signals owned by a different live lease", t => {
  const { hb, room, all } = leases(t);
  enqueue(hb, "ai_lease", 1);
  const batch = hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: room.fencingToken });
  const ids = batch.signals.map(s => s.signalId);
  // Tab's y-repro (10409/10473): the all-rooms listener acks the room
  // listener's claimed signal with its own live token — must be refused.
  assert.throws(
    () => hb.ackWakes({ agentId: "ai_lease", signalIds: ids, roomId: null, fencingToken: all.fencingToken }),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "wake_signal_fenced",
    "cross-scope ack of an owned signal is fenced by the actual owner");
  assert.equal(hb.pendingWakes("ai_lease", { roomId: ROOM }).length, 1, "the signal stays queued for its owner");
  // The owning lease can still ack its own batch.
  const ok = hb.ackWakes({ agentId: "ai_lease", signalIds: ids, roomId: ROOM, fencingToken: room.fencingToken });
  assert.equal(ok.acknowledged.length, 1, "the owner drains its own batch");
});

test("an untokened ack cannot take a signal owned by a live lease", t => {
  const { db, hb, room } = leases(t);
  enqueue(hb, "ai_lease", 1);
  // Drop the all-rooms lease so only the owner holds a live lease; the ack
  // below carries no scope lease at all and no token.
  db.prepare("DELETE FROM agent_wake_listener_leases WHERE room_key=''").run();
  const batch = hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: room.fencingToken });
  const ids = batch.signals.map(s => s.signalId);
  assert.throws(
    () => hb.ackWakes({ agentId: "ai_lease", signalIds: ids, roomId: null }),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "wake_signal_fenced",
    "token presence alone is not the fence — the actual owner is");
  assert.equal(hb.pendingWakes("ai_lease", { roomId: ROOM }).length, 1);
});

test("an abandoned claim must be re-claimed before it can be acked", t => {
  const { hb, advance, room } = leases(t);
  enqueue(hb, "ai_lease", 1);
  const batch = hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: room.fencingToken });
  const ids = batch.signals.map(s => s.signalId);
  advance(60001); // owner's lease lapses with the batch unacked.
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  // B never claimed the batch, so B's ack is refused even though A's lease
  // is dead: no listener deletes work it never handled.
  assert.throws(
    () => hb.ackWakes({ agentId: "ai_lease", signalIds: ids, roomId: ROOM, fencingToken: b.fencingToken }),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "wake_signal_fenced");
  assert.equal(hb.pendingWakes("ai_lease", { roomId: ROOM }).length, 1);
  // The designed recovery still works: reclaim (flagged redelivered), then ack.
  const redelivered = hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: b.fencingToken });
  assert.deepEqual(redelivered.signals.map(s => s.signalId), ids);
  assert.equal(redelivered.signals[0].redelivered, true);
  const ok = hb.ackWakes({ agentId: "ai_lease", signalIds: ids, roomId: ROOM, fencingToken: b.fencingToken });
  assert.equal(ok.acknowledged.length, 1, "the re-claiming owner drains its batch");
});

test("claim validation is atomic with the mutation: a lease lost mid-claim claims nothing", t => {
  const { db, hb, room } = leases(t);
  enqueue(hb, "ai_lease", 1);
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql, ...rest) => {
    if (typeof sql === "string" && sql.includes("INSERT INTO agent_wake_signal_claims")) {
      // Simulate a concurrent release landing between the token validation
      // and the mutation.
      db.exec("DELETE FROM agent_wake_listener_leases");
    }
    return realPrepare(sql, ...rest);
  };
  try {
    const batch = hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: room.fencingToken });
    assert.equal(batch.signals.length, 0, "no signal is claimed once the lease is gone");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signal_claims").get().n, 0,
      "no claim row is written for the dead token");
  } finally {
    db.prepare = realPrepare;
  }
});

test("ack validation is atomic with the mutation: a claim landing mid-ack is fenced", t => {
  const { db, hb, room, all } = leases(t);
  enqueue(hb, "ai_lease", 1);
  const ids = hb.pendingWakes("ai_lease", { roomId: ROOM }).map(s => s.signalId);
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql, ...rest) => {
    if (typeof sql === "string" && sql.includes("UPDATE agent_wake_signals SET delivered_at")) {
      // Simulate a concurrent claim landing between the ack's validation and
      // its mutation: the room lease takes the signal mid-ack.
      realPrepare(`INSERT INTO agent_wake_signal_claims
        (signal_id, agent_id, claimed_by, claimed_at, redelivered)
        VALUES (?, ?, ?, ?, 0)`).run(ids[0], "ai_lease", room.fencingToken, T0);
    }
    return realPrepare(sql, ...rest);
  };
  try {
    const res = hb.ackWakes({ agentId: "ai_lease", signalIds: ids, roomId: null, fencingToken: all.fencingToken });
    assert.equal(res.acknowledged.length, 0, "the mid-ack claim fences the write");
    assert.equal(hb.pendingWakes("ai_lease", { roomId: ROOM }).length, 1, "the signal stays queued for its owner");
  } finally {
    db.prepare = realPrepare;
  }
});
