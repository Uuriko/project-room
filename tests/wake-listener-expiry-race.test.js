// #2536 blocker (4) — expiry race (Dot review, room seq 10406): lease
// validation and the later claim/ack mutation can race across
// expiry/reacquisition. A listener validates its lease, the lease expires
// and a new listener acquires it, then the first listener's mutation still
// applies with its stale fencing token. The fix checks the fencing token
// inside the mutating statement itself (atomic with the write), so a stale
// token can never slip through the gap between a separate check and the
// mutation.
//
// The interleaving is injected deterministically: node:sqlite runs
// synchronously, so the racing acquire is executed from a db.prepare hook
// at the exact point the racy window opens (between the victim's lease
// validation and its mutation) — the interleaving a second server process
// sharing the database file can produce.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const ROOM = "muse-room";
const AGENT = "ai_lease";
const TTL = 60000;

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  t.after(() => db.close());
  const hb = new AgentHeartbeats({ db, now: () => at }, {});
  hb.heartbeat({ agentId: AGENT, hostId: "host-1", mode: "pull-only" });
  return { db, hb, advance: ms => { at += ms; } };
}

// Run fn between the victim's lease validation and its mutation: intercept
// the prepare of the mutating statement, restore the original prepare, and
// run the racing step before the statement is prepared.
function injectBetween(db, sqlPattern, fn) {
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    if (sqlPattern.test(sql)) {
      db.prepare = prepare;
      fn();
    }
    return prepare(sql);
  };
}

const leaseA = hb =>
  hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "listener-a", ttlMs: TTL });

// Blocker (4), claim half: listener A validates its lease, the lease lapses
// and listener B re-acquires it, then A's INSERT...SELECT still claims the
// signals under A's stale fencing token — two listeners then both believe
// they own the batch.
test("a claim validated before expiry cannot land after another listener re-acquires", t => {
  const { db, hb, advance } = unit(t);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m0" });
  const a = leaseA(hb);
  assert.ok(a.acquired, "a holds a live lease");

  let bToken = null;
  injectBetween(db, /INSERT INTO agent_wake_signal_claims/, () => {
    advance(TTL + 1); // a's lease lapses inside a's check-then-act window
    const b = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "listener-b", ttlMs: TTL });
    assert.ok(b.acquired, "b re-acquires the lapsed lease");
    bToken = b.fencingToken;
  });

  assert.throws(
    () => hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: a.fencingToken }),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "stale_listener",
    "the stale claim is refused, not applied");
  const rows = db.prepare("SELECT claimed_by AS claimedBy FROM agent_wake_signal_claims").all();
  assert.equal(rows.length, 0, "no claim row was written with the stale token");
  // The new holder's queue is not wedged: it claims the signal as a first claim.
  const batch = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: bToken });
  assert.equal(batch.signals.length, 1, "b claims the signal after the takeover");
  assert.equal(batch.signals[0].redelivered, false, "nothing was ever claimed, so no redelivery flag");
});

// Blocker (4), ack half: listener A validates its lease, the lease lapses
// and listener B re-acquires it, then A's UPDATE still marks the signals
// delivered — B's listener never sees them.
test("an ack validated before expiry cannot land after another listener re-acquires", t => {
  const { db, hb, advance } = unit(t);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m0" });
  const a = leaseA(hb);
  const batch = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: a.fencingToken });
  assert.equal(batch.signals.length, 1, "a claims the batch while its lease is live");
  const ids = batch.signals.map(s => s.signalId);

  let bToken = null;
  injectBetween(db, /UPDATE agent_wake_signals SET delivered_at/, () => {
    advance(TTL + 1); // a's lease lapses inside a's check-then-act window
    const b = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "listener-b", ttlMs: TTL });
    assert.ok(b.acquired, "b re-acquires the lapsed lease");
    bToken = b.fencingToken;
  });

  const res = hb.ackWakes({ agentId: AGENT, signalIds: ids, roomId: ROOM, fencingToken: a.fencingToken });
  assert.deepEqual(res.acknowledged, [], "the stale ack applies to nothing");
  const row = db.prepare("SELECT delivered_at AS deliveredAt FROM agent_wake_signals WHERE signal_id=?").get(ids[0]);
  assert.equal(row.deliveredAt, null, "the signal stays unacknowledged for the new holder");
  // The new holder can still drain it.
  const ok = hb.ackWakes({ agentId: AGENT, signalIds: ids, roomId: ROOM, fencingToken: bToken });
  assert.deepEqual(ok.acknowledged, ids, "b acks the batch with its own live lease");
});

// Guard: the atomic fencing must not over-block the normal path.
test("a live lease still claims and acks normally", t => {
  const { hb } = unit(t);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m0" });
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  const a = leaseA(hb);
  const batch = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: a.fencingToken });
  assert.equal(batch.signals.length, 2, "live lease claims the batch");
  assert.deepEqual(batch.signals.map(s => s.redelivered), [false, false], "first claim is not a redelivery");
  const ids = batch.signals.map(s => s.signalId);
  const ack = hb.ackWakes({ agentId: AGENT, signalIds: ids, roomId: ROOM, fencingToken: a.fencingToken });
  assert.deepEqual(ack.acknowledged, ids, "the fencing-token holder drains the batch");
  assert.equal(hb.pendingWakes(AGENT, { roomId: ROOM }).length, 0, "queue is empty");
});

// Backward compatibility: with no lease at all, claimWakeBatch still 409s
// and ackWakes keeps its old unfenced behavior.
test("without any lease, claims 409 and acks stay unfenced", t => {
  const { hb } = unit(t);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m0" });
  assert.throws(
    () => hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: "whatever" }),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "stale_listener",
    "no live lease for the token");
  const pending = hb.pendingWakes(AGENT, { roomId: ROOM });
  const ack = hb.ackWakes({ agentId: AGENT, signalIds: pending.map(s => s.signalId), roomId: ROOM });
  assert.equal(ack.acknowledged.length, 1, "no lease: unfenced acks still drain, exactly as before");
});
