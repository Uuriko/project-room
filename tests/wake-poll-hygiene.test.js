// Zulip event_queue style hygiene on the wake poll door: a pile of
// already-handled signals must not hide new work. (1) stale mention/dm doorbells
// are pruned, (2) ack=cursor acknowledges everything up to the cursor the client
// passes, (3) obligations, paused rooms, claimed signals and live leases are
// never swept. Real wake fabric, no stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { WAKE_STALE_PRUNE_MS } from "../server/agent-heartbeats.mjs";
import { heartbeatWithListener } from "../server/agent-listener-contract.mjs";
import { createTestClock } from "./helpers/test-clock.mjs";

function setup(t) {
  const f = createAcceptanceFixture(), clock = createTestClock(f.store.now());
  f.store.now = clock.now;
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const identity = f.store.identities.create("Poller");
  f.store.agentHeartbeats.heartbeat({ agentId: identity.identityId, hostId: "poll-host", mode: "wakeable", wakeUrl: "https://poll.example.test/wake" });
  const hb = f.store.agentHeartbeats, agentId = identity.identityId;
  const enqueue = (kind, messageId) => { clock.advance(5); return hb.enqueueWake({ agentId, kind, roomId: null, messageId }).signal; };
  const pending = () => hb.pendingWakes(agentId).map(s => s.messageId);
  return { f, clock, hb, agentId, identity, enqueue, pending };
}

test("stale mention/dm signals are pruned; fresh ones and obligations stay; a second settle is a no-op", t => {
  const { clock, hb, agentId, enqueue, pending } = setup(t);
  enqueue("mention", "old-1"); enqueue("dm", "old-2"); enqueue("ask", "old-ask");
  clock.advance(WAKE_STALE_PRUNE_MS + 1000);
  enqueue("mention", "fresh");
  const result = hb.settleWakes({ agentId });
  assert.equal(result.acknowledged.length, 2);
  assert.deepEqual(pending(), ["old-ask", "fresh"], "an obligation kind and the fresh signal survive");
  assert.equal(hb.settleWakes({ agentId }).acknowledged.length, 0, "idempotent");
});

test("ack=cursor acknowledges everything up to the cursor and nothing after it", t => {
  const { hb, agentId, enqueue, pending } = setup(t);
  for (let i = 1; i <= 5; i++) enqueue("mention", `m${i}`);
  const page = hb.pendingWakePage(agentId, { limit: 2 });
  assert.equal(page.more, true);
  assert.deepEqual(page.signals.map(s => s.messageId), ["m1", "m2"]);
  const result = hb.settleWakes({ agentId, cursor: page.nextCursor, ackThrough: true });
  assert.equal(result.acknowledged.length, 2);
  assert.deepEqual(pending(), ["m3", "m4", "m5"]);
  assert.equal(hb.settleWakes({ agentId, cursor: page.nextCursor, ackThrough: true }).acknowledged.length, 0, "replaying the cursor is idempotent");
});

test("ack=cursor needs a cursor bound to this scope", t => {
  const { hb, agentId, enqueue } = setup(t);
  for (let i = 1; i <= 3; i++) enqueue("mention", `x${i}`);
  const page = hb.pendingWakePage(agentId, { limit: 1 });
  assert.throws(() => hb.settleWakes({ agentId, ackThrough: true }), error => error.status === 422);
  assert.throws(() => hb.settleWakes({ agentId, roomId: "other-room", cursor: page.nextCursor, ackThrough: true }), error => error.status === 422);
  assert.throws(() => hb.settleWakes({ agentId, cursor: "bogus", ackThrough: true }), error => error.status === 422);
});

test("a live listener lease fences ack=cursor; the holder's token passes; claimed signals are never swept", t => {
  const { hb, agentId, enqueue, pending } = setup(t);
  for (let i = 1; i <= 3; i++) enqueue("mention", `l${i}`);
  const page = hb.pendingWakePage(agentId, { limit: 2 });
  const lease = hb.acquireListenerLease({ agentId, roomId: null, listenerId: "listener-a" });
  assert.throws(() => hb.settleWakes({ agentId, cursor: page.nextCursor, ackThrough: true }), error => error.status === 409 && error.code === "listener_fenced");
  assert.throws(() => hb.settleWakes({ agentId, cursor: page.nextCursor, ackThrough: true, fencingToken: "wrong" }), error => error.status === 409);
  assert.equal(pending().length, 3, "nothing acknowledged by the refused calls");
  const claimed = hb.claimWakeBatch({ agentId, roomId: null, fencingToken: lease.fencingToken, limit: 1 });
  assert.equal(claimed.signals?.length ?? claimed.length, 1);
  const result = hb.settleWakes({ agentId, cursor: page.nextCursor, ackThrough: true, fencingToken: lease.fencingToken });
  assert.equal(result.acknowledged.length, 1, "the claimed signal is left for its claimer; the other is acked");
});

test("HTTP poll: stale piles are pruned, ack=cursor works, bad values are rejected", async t => {
  const { f, clock, hb, agentId, identity, enqueue, pending } = setup(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeStreams(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const poll = qs => fetch(`${origin}/api/agent-wakes/poll?waitMs=0${qs}`, { headers: { authorization: `Bearer ${identity.secret}` } })
    .then(async res => ({ status: res.status, body: await res.json() }));

  for (let i = 1; i <= 3; i++) enqueue("mention", `old-${i}`);
  clock.advance(WAKE_STALE_PRUNE_MS + 1000);
  for (let i = 1; i <= 4; i++) enqueue("mention", `new-${i}`);
  const first = await poll("");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.pendingWakes.map(s => s.messageId), ["new-1", "new-2", "new-3", "new-4"], "the stale pile cannot hide new work");

  assert.equal((await poll("&ack=yes")).status, 422);
  assert.equal((await poll("&ack=cursor")).status, 422, "ack=cursor without a cursor");
  assert.equal((await poll("&ack=cursor&order=newest")).status, 422);

  const page = hb.pendingWakePage(agentId, { limit: 2, hostId: "poll-host" });
  const acked = await poll(`&hostId=poll-host&cursor=${encodeURIComponent(page.nextCursor)}&ack=cursor`);
  assert.equal(acked.status, 200);
  assert.deepEqual(acked.body.pendingWakes.map(s => s.messageId), ["new-3", "new-4"]);
  assert.deepEqual(pending(), ["new-3", "new-4"]);
});

// Follow-up from the #6161 review (method-level reproductions by Dot): the
// cursor must never settle obligation kinds, and the age prune must respect a
// live lease on the signals' own room.
test("ack=cursor leaves fresh obligation signals pending and settles only doorbell kinds", t => {
  const { hb, agentId, enqueue, pending } = setup(t);
  for (const kind of ["ask", "assignment", "bond", "land"]) enqueue(kind, kind);
  enqueue("mention", "last"); enqueue("mention", "after");
  const page = hb.pendingWakePage(agentId, { limit: 5 });
  assert.equal(page.signals.length, 5);
  const result = hb.settleWakes({ agentId, cursor: page.nextCursor, ackThrough: true });
  assert.deepEqual(result.acknowledged.length, 1, "only the mention inside the cursor is settled");
  assert.deepEqual(pending(), ["ask", "assignment", "bond", "land", "after"]);
});

test("the age prune never deletes signals under another listener's live lease (no token, wrong token); the holder's token prunes", t => {
  const { clock, hb, agentId, enqueue, pending } = setup(t);
  enqueue("mention", "old");
  clock.advance(WAKE_STALE_PRUNE_MS + 1000);
  const lease = hb.acquireListenerLease({ agentId, roomId: null, listenerId: "holder" });
  assert.deepEqual(hb.settleWakes({ agentId }).acknowledged, [], "plain poll is non-consuming under a foreign lease");
  assert.deepEqual(hb.settleWakes({ agentId, fencingToken: "wrong" }).acknowledged, []);
  assert.deepEqual(pending(), ["old"]);
  assert.equal(hb.settleWakes({ agentId, fencingToken: lease.fencingToken }).acknowledged.length, 1);
  assert.deepEqual(pending(), []);
});

test("lease checks follow the selected signals' room: an unrelated or expired lease does not block, a same-room lease does", t => {
  const { clock, hb, agentId } = setup(t);
  const enqueueRoom = (roomId, messageId) => { clock.advance(5); return hb.enqueueWake({ agentId, kind: "mention", roomId, messageId }).signal; };
  enqueueRoom("room-a", "a-old"); enqueueRoom("room-b", "b-old");
  clock.advance(WAKE_STALE_PRUNE_MS + 1000);
  hb.acquireListenerLease({ agentId, roomId: "room-b", listenerId: "holder-b" });
  const pruned = hb.settleWakes({ agentId, roomId: "room-a" });
  assert.equal(pruned.acknowledged.length, 1, "room-a is not covered by room-b's lease");
  assert.deepEqual(hb.pendingWakes(agentId).map(s => s.messageId), ["b-old"]);
  assert.deepEqual(hb.settleWakes({ agentId, roomId: "room-b" }).acknowledged, [], "room-b's own lease keeps its signal");
  assert.deepEqual(hb.settleWakes({ agentId }).acknowledged, [], "an identity-wide prune also skips the leased room");
  clock.advance(10 * 60 * 1000);
  assert.equal(hb.settleWakes({ agentId }).acknowledged.length, 1, "an expired lease no longer holds it");
});



test("pruneStaleWakes clears stale mention/dm doorbells across agents; obligations stay", t => {
  const { f, clock, hb, enqueue, pending } = setup(t);
  const other = f.store.identities.create("Other");
  hb.heartbeat({ agentId: other.identityId, hostId: "other-host", mode: "wakeable", wakeUrl: "https://poll.example.test/other" });
  const enqueueOther = (kind, messageId) => { clock.advance(5); return hb.enqueueWake({ agentId: other.identityId, kind, roomId: null, messageId }).signal; };
  const pendingOther = () => hb.pendingWakes(other.identityId).map(s => s.messageId);
  enqueue("mention", "old-a"); enqueue("ask", "old-ask");
  enqueueOther("dm", "old-b"); enqueueOther("assignment", "old-asg");
  clock.advance(WAKE_STALE_PRUNE_MS + 1000);
  enqueue("mention", "fresh-a");
  enqueueOther("mention", "fresh-b");
  assert.equal(hb.staleWakesPending(), true);
  const result = hb.pruneStaleWakes();
  assert.equal(result.pruned, 2);
  assert.deepEqual(pending(), ["old-ask", "fresh-a"]);
  assert.deepEqual(pendingOther(), ["old-asg", "fresh-b"]);
  assert.equal(hb.staleWakesPending(), false);
  assert.equal(hb.pruneStaleWakes().pruned, 0, "idempotent");
});

test("a heartbeat settles stale mention/dm doorbells the same way poll does", t => {
  const { f, clock, agentId, enqueue, pending } = setup(t);
  enqueue("mention", "hb-old"); enqueue("ask", "hb-ask");
  clock.advance(WAKE_STALE_PRUNE_MS + 1000);
  enqueue("mention", "hb-fresh");
  f.store.transaction(() => {
    heartbeatWithListener(f.store, { identityId: agentId }, { hostId: "poll-host", mode: "wakeable" });
  });
  assert.deepEqual(pending(), ["hb-ask", "hb-fresh"]);
});
