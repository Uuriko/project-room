// Bolter steal #5: single-listener leases with fencing tokens, atomic
// batch claims, and redelivery flags on the wake-signal queue.
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
  return { hb: new AgentHeartbeats({ db, now: () => at }, {}), advance: ms => { at += ms; } };
}

const wakeable = (agentId = "ai_lease", hostId = "host-1") =>
  ({ agentId, hostId, mode: "pull-only" });

function enqueue(hb, agentId, n, roomId = ROOM) {
  for (let i = 0; i < n; i++) hb.enqueueWake({ agentId, kind: "mention", roomId, messageId: `m${i}` });
}

// Heartbeat + one live lease held by listenerId.
function leased(t, listenerId = "listener-a") {
  const { hb, advance } = unit(t);
  hb.heartbeat(wakeable());
  return { hb, advance, lease: hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId, ttlMs: 60000 }) };
}

const claim = (hb, token, limit = 5) =>
  hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: token, limit });

test("a second listener is refused and the running listener is named", t => {
  const { hb } = leased(t);
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(b.acquired, false, "second listener refused while the lease is live");
  assert.equal(b.activeListenerId, "listener-a", "refusal names the running listener");
});

test("the same listener renews its own lease and keeps its fencing token", t => {
  const { hb, advance, lease } = leased(t);
  assert.ok(lease.fencingToken.length > 0, "fencing token issued");
  advance(30000);
  const renewed = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(renewed.acquired, true);
  assert.equal(renewed.fencingToken, lease.fencingToken, "renewal keeps the token so in-flight acks stay valid");
});

test("an expired lease can be re-acquired by another listener", t => {
  const { hb, advance } = leased(t);
  advance(60001);
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(b.acquired, true, "expired lease is free for another listener");
  assert.ok(b.fencingToken.length > 0);
});

test("claimWakeBatch claims atomically; acks are fenced by the token", t => {
  const { hb, lease } = leased(t);
  enqueue(hb, "ai_lease", 3);
  const batch = claim(hb, lease.fencingToken, 2);
  assert.equal(batch.signals.length, 2, "batch claims the two oldest signals");
  assert.deepEqual(batch.signals.map(s => s.redelivered), [false, false], "first claim is not a redelivery");
  const ids = batch.signals.map(s => s.signalId);
  const ack = extra => ({ agentId: "ai_lease", signalIds: ids, roomId: ROOM, ...extra });
  assert.throws(() => hb.ackWakes(ack({ fencingToken: "bogus" })),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "listener_fenced");
  assert.throws(() => hb.ackWakes(ack()),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "listener_fenced");
  const ok = hb.ackWakes(ack({ fencingToken: lease.fencingToken }));
  assert.equal(ok.acknowledged.length, 2, "the fencing token holder drains the batch");
  assert.equal(hb.pendingWakes("ai_lease", { roomId: ROOM }).length, 1, "one signal left unclaimed");
});

test("a stale fencing token is rejected by claimWakeBatch", t => {
  const { hb, advance, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  advance(60001);
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(b.acquired, true);
  assert.throws(() => claim(hb, lease.fencingToken),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "stale_listener");
  assert.equal(claim(hb, b.fencingToken).signals.length, 1);
});

test("a dead listener's batch is redelivered with the flag set", t => {
  const { hb, advance, lease } = leased(t);
  enqueue(hb, "ai_lease", 2);
  const first = claim(hb, lease.fencingToken);
  assert.equal(first.signals.length, 2);
  advance(60001); // listener-a dies mid-batch: lease lapses, nothing acked.
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  const redelivered = claim(hb, b.fencingToken);
  assert.deepEqual(redelivered.signals.map(s => s.signalId).sort(), first.signals.map(s => s.signalId).sort(),
    "the same batch comes back");
  assert.deepEqual(redelivered.signals.map(s => s.redelivered), [true, true], "redelivery is flagged");
});

test("releaseListenerLease frees the batch for prompt redelivery", t => {
  const { hb, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  const first = claim(hb, lease.fencingToken);
  assert.equal(hb.releaseListenerLease({ agentId: "ai_lease", roomId: ROOM, fencingToken: lease.fencingToken }).released, true);
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  const again = claim(hb, b.fencingToken);
  assert.equal(again.signals.length, 1, "released claims are immediately reclaimable");
  assert.equal(again.signals[0].redelivered, true, "re-claim after release is flagged redelivered");
  assert.equal(again.signals[0].signalId, first.signals[0].signalId);
});

test("without any lease, ackWakes keeps its old behavior", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  enqueue(hb, "ai_lease", 2);
  const pending = hb.pendingWakes("ai_lease", { roomId: ROOM });
  const ok = hb.ackWakes({ agentId: "ai_lease", signalIds: pending.map(s => s.signalId), roomId: ROOM });
  assert.equal(ok.acknowledged.length, 2, "no lease: unfenced acks still drain, exactly as before");
});

test("leases are room-scoped", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  const a = hb.acquireListenerLease({ agentId: "ai_lease", roomId: "room-one", listenerId: "listener-a", ttlMs: 60000 });
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: "room-two", listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(a.acquired && b.acquired, true, "a different room gets its own lease");
  assert.notEqual(a.fencingToken, b.fencingToken);
});

test("lease inputs are validated", t => {
  const { hb } = leased(t);
  const bad = [
    () => hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "bad id!", ttlMs: 60000 }),
    () => hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-a", ttlMs: 0 }),
    () => claim(hb, "x", 0),
  ];
  for (const fn of bad) assert.throws(fn, err => err instanceof HeartbeatError && err.status === 422);
});

// --- WAVE-500 guild 9 slice A4: fail-first REPRO for #2536 blocker (4) ---
// Lease validation and the later claim/ack mutation are separate statements.
// If listener-a's lease expires and listener-b reacquires between the
// validation SELECT and the mutation, the stale fencing token's mutation
// still lands: validate-then-mutate is not atomic. These tests simulate that
// interleaving deterministically — listener-a validates while live, then
// listener-b takes over (past listener-a's expiry) at the seam between the
// validation and the mutation statement — and assert the stale token mutates
// nothing. They FAIL until the mutation is fenced atomically. No fix here.
function raceReacquireBetweenValidationAndMutation(t, hb, advance, mutationSqlFragment) {
  const realPrepare = hb.db.prepare.bind(hb.db);
  let bLease = null;
  let fired = false;
  hb.db.prepare = sql => {
    const stmt = realPrepare(sql);
    if (!fired && typeof sql === "string" && sql.includes(mutationSqlFragment)) {
      fired = true;
      advance(60001); // listener-a's lease lapses...
      bLease = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
    }
    return stmt;
  };
  t.after(() => { hb.db.prepare = realPrepare; });
  return () => {
    assert.ok(fired, "the mutation statement was reached");
    assert.ok(bLease && bLease.acquired, "listener-b reacquired the lease mid-call");
    return bLease;
  };
}

test("[remedy-a4] claimWakeBatch: a stale token must not claim after expiry + reacquisition", t => {
  const { hb, advance, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  const reacquired = raceReacquireBetweenValidationAndMutation(t, hb, advance, "INSERT INTO agent_wake_signal_claims");
  const batch = claim(hb, lease.fencingToken); // validates while listener-a is live; mutates after listener-b's takeover
  const bLease = reacquired();
  assert.equal(batch.signals.length, 0,
    "stale fencing token claimed a signal after the lease was reacquired — validate-then-mutate is not atomic");
  assert.equal(claim(hb, bLease.fencingToken).signals.length, 1,
    "the signal stays claimable by the rightful lease holder");
});

test("[remedy-a4] ackWakes: a stale token must not ack after expiry + reacquisition", t => {
  const { hb, advance, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  const ids = claim(hb, lease.fencingToken).signals.map(s => s.signalId);
  assert.equal(ids.length, 1);
  const reacquired = raceReacquireBetweenValidationAndMutation(t, hb, advance, "UPDATE agent_wake_signals SET delivered_at");
  const res = hb.ackWakes({ agentId: "ai_lease", signalIds: ids, roomId: ROOM, fencingToken: lease.fencingToken });
  reacquired();
  assert.equal(res.acknowledged.length, 0,
    "stale fencing token acked signals after the lease was reacquired — validate-then-mutate is not atomic");
  assert.equal(hb.pendingWakes("ai_lease", { roomId: ROOM }).length, 1,
    "the signal is still pending for the rightful lease holder");
});

// --- WAVE-500 guild 4 (claims & receipts): stale-token race probe, part 2 ---
// Re-acquire semantics after expiry, and no cross-talk between the old and
// new holder's batches. Extends the A4 seam-race repros above; no overlap
// with guild-9 slices A1 (scope dup), A2 (ack ownership) or A5 (atomic acquire).
test("[g4-stale-token] same listener re-acquiring after expiry gets a NEW token; the old one dies", t => {
  const { hb, advance, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  const oldToken = lease.fencingToken;
  advance(60001); // listener-a's lease lapses
  const again = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(again.acquired, true, "re-acquire after expiry succeeds");
  assert.equal(again.renewed, false, "this is a fresh acquire, not a renewal");
  assert.notEqual(again.fencingToken, oldToken, "re-acquire mints a NEW fencing token — the old one must die");
  // The dead token is rejected outright on the non-raced path...
  assert.throws(() => claim(hb, oldToken),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "stale_listener",
    "dead token: claimWakeBatch 409s stale_listener");
  assert.throws(() => hb.ackWakes({ agentId: "ai_lease", signalIds: ["ws_dead"], roomId: ROOM, fencingToken: oldToken }),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "listener_fenced",
    "dead token: ackWakes 409s listener_fenced while the new lease is live");
  // ...and the new token works end to end.
  const batch = claim(hb, again.fencingToken);
  assert.equal(batch.signals.length, 1, "new token claims");
  const acked = hb.ackWakes({ agentId: "ai_lease", signalIds: batch.signals.map(s => s.signalId), roomId: ROOM, fencingToken: again.fencingToken });
  assert.equal(acked.acknowledged.length, 1, "new token acks");
});

test("[g4-stale-token] a raced stale claim leaves no trace on the new holder's batch", t => {
  const { hb, advance, lease } = leased(t);
  enqueue(hb, "ai_lease", 2);
  const reacquired = raceReacquireBetweenValidationAndMutation(t, hb, advance, "INSERT INTO agent_wake_signal_claims");
  const staleBatch = claim(hb, lease.fencingToken); // validates live, mutates after listener-b's takeover
  const bLease = reacquired();
  assert.equal(staleBatch.signals.length, 0, "stale token claims nothing");
  const bBatch = claim(hb, bLease.fencingToken);
  assert.equal(bBatch.signals.length, 2, "new holder gets the whole batch");
  assert.deepEqual(bBatch.signals.map(s => s.redelivered), [false, false],
    "no cross-talk: the stale attempt left no claim rows behind, so nothing is misflagged redelivered");
  const rows = hb.db.prepare("SELECT DISTINCT claimed_by FROM agent_wake_signal_claims").all();
  assert.deepEqual(rows.map(r => r.claimed_by), [bLease.fencingToken],
    "every claim row belongs to the live holder's token only");
});

test("[g4-stale-token] a raced stale ack leaves the signal pending and unclaimed-by-dead-token", t => {
  const { hb, advance, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  const ids = claim(hb, lease.fencingToken).signals.map(s => s.signalId);
  const reacquired = raceReacquireBetweenValidationAndMutation(t, hb, advance, "UPDATE agent_wake_signals SET delivered_at");
  const res = hb.ackWakes({ agentId: "ai_lease", signalIds: ids, roomId: ROOM, fencingToken: lease.fencingToken });
  const bLease = reacquired();
  assert.equal(res.acknowledged.length, 0, "stale token acks nothing");
  const row = hb.db.prepare("SELECT delivered_at FROM agent_wake_signals WHERE signal_id=?").get(ids[0]);
  assert.equal(row.delivered_at, null, "signal row untouched by the stale ack");
  // The rightful holder can still claim + ack the signal afterwards.
  const bBatch = claim(hb, bLease.fencingToken);
  assert.equal(bBatch.signals.length, 1);
  const acked = hb.ackWakes({ agentId: "ai_lease", signalIds: [ids[0]], roomId: ROOM, fencingToken: bLease.fencingToken });
  assert.equal(acked.acknowledged.length, 1, "new holder acks cleanly");
});
