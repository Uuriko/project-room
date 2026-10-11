// Wake waiter edge cases (WAVE-500 guild 5 worker E2): onWake throwing,
// _releaseWakeWaiter roomId scoping, notePoll for unregistered agents, and
// release-function idempotency in server/agent-heartbeats.mjs.
//
// Authoring gate (repo test-audit): each test names the observable
// contract, the credible regression, why existing coverage misses it, and
// confirms no test-only production seam was added.
//
// 1. throwing onWake must not starve sibling waiters — contract:
//    _releaseWakeWaiter notifies EVERY matching waiter; one bad callback
//    neither aborts the release loop nor leaves waiters stranded.
//    Regression: a single throwing onWake silently dropping wake
//    notifications for all other hosts of the same agent (their long
//    polls hang until timeout). Existing coverage (agent-wake-poll.test.js
//    "two hosts wait side by side") only exercises non-throwing
//    callbacks.
// 2. roomId scoping — contract: a waiter with roomId=null is released by
//    any room's signal; a waiter with roomId=X is NOT released by room Y's
//    signal but IS by room X's. Regression: cross-room signal leaks
//    waking the wrong room's poll, or null waiters missing signals.
// 3. notePoll for unregistered agents — contract: returns the
//    registered:false shape without throwing. Regression: a refactor
//    that throws (or lets an unknown agent wait) on the HTTP poll path.
// 4. release idempotency — contract: double release is a no-op; a stale
//    release (after replacement or after the waiter fired) never deletes
//    the live waiter. Regression: a reconnect's old release handle
//    killing the new waiter's slot and wedging the host.
//
// Synthetic fixtures only — in-memory SQLite, no network, no real
// credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, agentHeartbeatSchema, HEARTBEAT_STALE_AFTER_MS,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, { staleAfterMs: HEARTBEAT_STALE_AFTER_MS });
  t.after(() => db.close());
  return { hb };
}

test("a throwing onWake during signal release does not starve the other waiters", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_edge_throw", hostId: "h-a" });
  hb.heartbeat({ agentId: "ai_edge_throw", hostId: "h-b" });
  let b = 0;
  // h-a's callback throws; h-b's counts. Insertion order is load-bearing:
  // h-a releases first, so its throw hits before h-b is reached.
  const releaseA = hb.addWakeWaiter("ai_edge_throw", "h-a", {
    roomId: null, onWake: () => { throw new Error("boom"); },
  });
  const releaseB = hb.addWakeWaiter("ai_edge_throw", "h-b", {
    roomId: null, onWake: () => { b++; },
  });
  t.after(releaseA); t.after(releaseB);
  assert.doesNotThrow(() => hb.enqueueWake({
    agentId: "ai_edge_throw", kind: "mention", roomId: "commons", messageId: "m-1",
  }), "the wake path must not fail the message post");
  assert.equal(b, 1, "the throwing waiter must not starve the sibling waiter");
  // Both waiters are single-shot: re-registering must not resurrect a
  // stranded entry, and a second signal must wake only the new waiter.
  let b2 = 0;
  const releaseB2 = hb.addWakeWaiter("ai_edge_throw", "h-b", {
    roomId: null, onWake: () => { b2++; },
  });
  t.after(releaseB2);
  hb.enqueueWake({ agentId: "ai_edge_throw", kind: "mention", roomId: "commons", messageId: "m-2" });
  assert.equal(b, 1, "the released waiter stays released (no stranded entry)");
  assert.equal(b2, 1, "the new waiter fires for the next signal");
});

test("roomId=null waiters release on any room's signal; roomId=X waiters only on room X", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_edge_scope", hostId: "h" });
  let wild = 0, scoped = 0;
  const relWild = hb.addWakeWaiter("ai_edge_scope", "h-wild", {
    roomId: null, onWake: () => { wild++; },
  });
  const relScoped = hb.addWakeWaiter("ai_edge_scope", "h-scoped", {
    roomId: "room-x", onWake: () => { scoped++; },
  });
  t.after(relWild); t.after(relScoped);
  hb.enqueueWake({ agentId: "ai_edge_scope", kind: "mention", roomId: "room-y", messageId: "m-1" });
  assert.equal(wild, 1, "roomId=null waiter is released by any room's signal");
  assert.equal(scoped, 0, "roomId=room-x waiter is NOT released by room-y's signal");
  // Re-register the consumed wildcard; the scoped waiter is still waiting.
  const relWild2 = hb.addWakeWaiter("ai_edge_scope", "h-wild", {
    roomId: null, onWake: () => { wild++; },
  });
  t.after(relWild2);
  hb.enqueueWake({ agentId: "ai_edge_scope", kind: "mention", roomId: "room-x", messageId: "m-2" });
  assert.equal(wild, 2, "wildcard fires again for the next signal");
  assert.equal(scoped, 1, "room-x signal releases the room-x waiter");
});

test("notePoll for an unregistered agent returns registered:false without throwing", t => {
  const { hb } = unit(t);
  let poll;
  assert.doesNotThrow(() => { poll = hb.notePoll({ agentId: "ai_edge_nobody" }); });
  assert.equal(poll.registered, false);
  assert.deepEqual(poll.pendingWakes, []);
});

test("release is idempotent and a stale release never kills the live waiter", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_edge_rel", hostId: "h" });
  let v1 = 0, v2 = 0;
  const releaseV1 = hb.addWakeWaiter("ai_edge_rel", "h", {
    roomId: null, onWake: () => { v1++; },
  });
  // Reconnect replaces the waiter; the old one resolves immediately.
  const releaseV2 = hb.addWakeWaiter("ai_edge_rel", "h", {
    roomId: null, onWake: () => { v2++; },
  });
  assert.equal(v1, 1, "replaced waiter is released");
  // Double-release of the stale handle is a no-op and must not delete v2.
  releaseV1(); releaseV1();
  hb.enqueueWake({ agentId: "ai_edge_rel", kind: "mention", roomId: "commons", messageId: "m-1" });
  assert.equal(v2, 1, "stale release handle did not kill the live waiter");
  // Releasing after the waiter already fired is safe and not double-counted.
  releaseV2(); releaseV2();
  assert.equal(v2, 1);
});

test("a throwing onWake on the replaced waiter does not break the new waiter", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_edge_repl", hostId: "h" });
  let v2 = 0;
  const releaseV1 = hb.addWakeWaiter("ai_edge_repl", "h", {
    roomId: null, onWake: () => { throw new Error("stale boom"); },
  });
  const releaseV2 = hb.addWakeWaiter("ai_edge_repl", "h", {
    roomId: null, onWake: () => { v2++; },
  });
  t.after(releaseV1); t.after(releaseV2);
  hb.enqueueWake({ agentId: "ai_edge_repl", kind: "mention", roomId: "commons", messageId: "m-1" });
  assert.equal(v2, 1, "the new waiter survives a throwing predecessor");
});
