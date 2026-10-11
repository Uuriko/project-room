// WAVE-500 guild 5 worker C7: lease expiry during a held wake poll.
// A held GET /api/agent-wakes/poll registers an in-process waiter; the poll
// returns notePoll()'s pending set. If the listener's lease expires mid-wait
// and another listener acquires the lease and claims the batch, the first
// poll must not deliver signals it no longer owns — it cannot claim them
// and cannot ack them (409 listener_fenced once another lease is live).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, agentHeartbeatSchema,
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

const registered = hb => hb.heartbeat({ agentId: "ai_poll", hostId: "host-1", mode: "pull-only" });

test("a held poll does not deliver signals claimed by another listener's live lease", t => {
  const { hb, advance } = unit(t);
  registered(hb);
  // Listener A holds the lease and a waiter — the held long poll.
  const a = hb.acquireListenerLease({ agentId: "ai_poll", roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(a.acquired, true);
  let woke = 0;
  const release = hb.addWakeWaiter("ai_poll", "host-1", { roomId: ROOM, onWake: () => { woke++; } });
  t.after(release);
  // A's lease expires mid-wait; a new signal lands and the waiter fires.
  advance(60001);
  hb.enqueueWake({ agentId: "ai_poll", kind: "mention", roomId: ROOM, messageId: "m1" });
  assert.equal(woke, 1, "lease expiry does not release the waiter — it still fires");
  // Listener B takes over the lease and claims the batch before A's poll returns.
  const b = hb.acquireListenerLease({ agentId: "ai_poll", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(b.acquired, true, "expired lease is free for another listener");
  const batch = hb.claimWakeBatch({ agentId: "ai_poll", roomId: ROOM, fencingToken: b.fencingToken });
  assert.equal(batch.signals.length, 1, "B claimed the signal");
  // When the first poll returns, it must not hand A a signal B now owns.
  const polled = hb.notePoll({ agentId: "ai_poll", roomId: ROOM });
  assert.deepEqual(polled.pendingWakes.map(s => s.signalId), [],
    "signals claimed under a live lease are not delivered to the held poll");
});

test("without a live lease the poll still returns everything (backward compatible)", t => {
  const { hb } = unit(t);
  registered(hb);
  hb.enqueueWake({ agentId: "ai_poll", kind: "mention", roomId: ROOM, messageId: "m1" });
  const polled = hb.notePoll({ agentId: "ai_poll", roomId: ROOM });
  assert.equal(polled.pendingWakes.length, 1, "no lease: the poll is unchanged");
});

test("claims under an expired lease become poll-visible again", t => {
  const { hb, advance } = unit(t);
  registered(hb);
  const a = hb.acquireListenerLease({ agentId: "ai_poll", roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 });
  hb.enqueueWake({ agentId: "ai_poll", kind: "mention", roomId: ROOM, messageId: "m1" });
  const batch = hb.claimWakeBatch({ agentId: "ai_poll", roomId: ROOM, fencingToken: a.fencingToken });
  assert.equal(batch.signals.length, 1);
  advance(60001); // the lease lapses; the claim no longer has a live owner
  const polled = hb.notePoll({ agentId: "ai_poll", roomId: ROOM });
  assert.equal(polled.pendingWakes.length, 1, "no live lease: claimed signals are poll-visible again");
});
