// room_wait (ROOM-WAIT): the MCP listen call. Specimens for the charter's
// four semantic constraints, run against a real HTTP MCP door:
//   1. a waiting call receives a mention posted mid-wait, with the message
//      body and a cursor, well inside its wait budget;
//   2. receipt/cursor progress is NOT acknowledgement — the signal stays
//      pending, a cursor suppresses re-delivery without consuming, and
//      only heartbeat_ack (after a reply) discharges it;
//   3. the call holds the listener lease for its duration, and the
//      receiving status distinguishes listening / connected / pull-only;
//   4. fresh fencing — a contended second listener gets no signals and
//      does not disturb the first, and a cursor minted for another scope
//      is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-room-wait-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store, rooms });
  }));
}

function rpc(origin, method, params, secret) {
  return fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) })
  });
}

async function call(origin, name, args, secret) {
  const response = await rpc(origin, "tools/call", { name, arguments: args }, secret);
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent, raw: JSON.stringify(body) };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Owner + room + a linked agent member ("listener") who can be mentioned.
function setup(store, rooms) {
  const owner = store.identities.create("Wait owner");
  const created = rooms.create(owner.secret, {
    roomId: "wait-den", title: "Wait den", purpose: "room_wait specimens", kind: "personal", displayName: "Wait owner"
  });
  const listener = store.identities.create("Listener");
  const linked = store.identities.link(owner.secret, "wait-den", {
    identityId: listener.identityId, memberId: "listener", displayName: "Listener", permissions: []
  });
  return { owner, created, listener, linked };
}

function post(store, secret, data) {
  return store.command(secret, "wait-den", { id: randomUUID(), type: "message.posted", data });
}

test("room_wait receives a mention posted mid-wait, with body and cursor", async t => {
  const { origin, store, rooms } = await serve(t);
  const { owner, created, listener } = setup(store, rooms);
  const beat = await call(origin, "heartbeat_set", { hostId: "waiter-1", mode: "wakeable" }, listener.secret);
  assert.equal(beat.value.host.hostId, "waiter-1", beat.raw);

  const startedAt = Date.now();
  const waiting = call(origin, "room_wait", { hostId: "waiter-1", waitMs: 8000 }, listener.secret);
  await sleep(250);
  post(store, owner.secret, { messageId: "mention-1", body: "hey @listener, the deploy needs you" });
  const result = await waiting;
  const elapsed = Date.now() - startedAt;

  assert.equal(result.value.pendingWakes.length, 1, result.raw);
  const signal = result.value.pendingWakes[0];
  assert.equal(signal.kind, "mention");
  assert.equal(signal.messageId, "mention-1");
  assert.equal(signal.message.body, "hey @listener, the deploy needs you");
  assert.equal(signal.message.authorId, created.ownerMemberId);
  assert.equal(typeof result.value.cursor, "string");
  assert.ok(result.value.cursor.length > 0);
  assert.equal(result.value.timedOut, false);
  assert.ok(result.value.waitedMs < 8000, `waitedMs ${result.value.waitedMs}`);
  assert.ok(elapsed < 4000, `mid-wait delivery resolved in ${elapsed}ms`);
  assert.equal(result.value.listener.acquired, true);
  assert.equal(typeof result.value.listener.fencingToken, "string");
  assert.equal(result.value.receiving.status, "listening");
  assert.equal(result.value.receiving.mode, "wakeable");
});

test("cursor progress is not acknowledgement; only ack after a reply discharges", async t => {
  const { origin, store, rooms } = await serve(t);
  const { owner, listener } = setup(store, rooms);
  await call(origin, "heartbeat_set", { hostId: "waiter-1", mode: "wakeable" }, listener.secret);
  post(store, owner.secret, { messageId: "mention-1", body: "hey @listener, question for you" });

  const first = await call(origin, "room_wait", { hostId: "waiter-1", waitMs: 0 }, listener.secret);
  assert.equal(first.value.pendingWakes.length, 1, first.raw);
  const signal = first.value.pendingWakes[0];
  const cursor = first.value.cursor;
  assert.ok(cursor, "first wait mints a cursor");

  // Receiving changed nothing: the signal is still pending at the store.
  assert.deepEqual(store.agentHeartbeats.pendingWakes(listener.identityId).map(s => s.signalId), [signal.signalId]);

  // The cursor suppresses re-delivery (receipt progress) — and still
  // consumes nothing: a cursorless wait returns the same signal again.
  const suppressed = await call(origin, "room_wait", { hostId: "waiter-1", waitMs: 300, cursor }, listener.secret);
  assert.equal(suppressed.value.pendingWakes.length, 0, suppressed.raw);
  assert.equal(suppressed.value.timedOut, true);
  assert.equal(suppressed.value.cursor, cursor, "an empty page leaves the position untouched");
  const again = await call(origin, "room_wait", { hostId: "waiter-1", waitMs: 0 }, listener.secret);
  assert.deepEqual(again.value.pendingWakes.map(s => s.signalId), [signal.signalId], again.raw);

  // A reply alone does not discharge through room_wait either: the signal
  // is still returned until the explicit ack door runs.
  post(store, listener.secret, { messageId: "reply-1", body: "on it", replyToId: "mention-1" });
  const afterReply = await call(origin, "room_wait", { hostId: "waiter-1", waitMs: 0 }, listener.secret);
  assert.deepEqual(afterReply.value.pendingWakes.map(s => s.signalId), [signal.signalId], afterReply.raw);

  const ack = await call(origin, "heartbeat_ack",
    { signalIds: [signal.signalId], fencingToken: first.value.listener.fencingToken }, listener.secret);
  assert.deepEqual(ack.value.acknowledged, [signal.signalId], ack.raw);
  const drained = await call(origin, "room_wait", { hostId: "waiter-1", waitMs: 0 }, listener.secret);
  assert.equal(drained.value.pendingWakes.length, 0, drained.raw);
  assert.deepEqual(store.agentHeartbeats.pendingWakes(listener.identityId), []);
});

test("a contended second listener receives nothing and does not disturb the first", async t => {
  const { origin, store, rooms } = await serve(t);
  const { owner, listener } = setup(store, rooms);
  await call(origin, "heartbeat_set", { hostId: "host-a", mode: "wakeable" }, listener.secret);
  await call(origin, "heartbeat_set", { hostId: "host-b", mode: "wakeable" }, listener.secret);

  const firstWait = call(origin, "room_wait", { hostId: "host-a", waitMs: 8000 }, listener.secret);
  await sleep(250);
  const startedAt = Date.now();
  const contender = await call(origin, "room_wait", { hostId: "host-b", waitMs: 8000 }, listener.secret);
  const contenderElapsed = Date.now() - startedAt;
  assert.ok(contenderElapsed < 4000, `contender returned in ${contenderElapsed}ms, not after its waitMs`);
  assert.equal(contender.value.listener.acquired, false, contender.raw);
  assert.equal(contender.value.listener.activeListenerId, "host-a");
  assert.equal(contender.value.pendingWakes.length, 0);
  assert.equal(contender.value.receiving.status, "connected");
  assert.equal(contender.value.timedOut, false);

  // The mention still lands on the first listener, unconsumed by the second.
  post(store, owner.secret, { messageId: "mention-1", body: "hey @listener, still yours" });
  const first = await firstWait;
  assert.equal(first.value.pendingWakes.length, 1, first.raw);
  assert.equal(first.value.pendingWakes[0].messageId, "mention-1");
  assert.equal(first.value.listener.acquired, true);
});

test("a cursor minted for another scope is refused, stale or foreign", async t => {
  const { origin, store, rooms } = await serve(t);
  const { owner, listener } = setup(store, rooms);
  await call(origin, "heartbeat_set", { hostId: "waiter-1", mode: "wakeable" }, listener.secret);
  post(store, owner.secret, { messageId: "mention-1", body: "hey @listener, scoped" });
  const first = await call(origin, "room_wait", { hostId: "waiter-1", waitMs: 0, roomId: "wait-den" }, listener.secret);
  assert.equal(first.value.pendingWakes.length, 1, first.raw);
  const roomCursor = first.value.cursor;
  assert.ok(roomCursor);

  // Same identity, same host, different room scope: the cursor's bound
  // scope no longer matches, so it is refused rather than reinterpreted.
  const wrongRoom = await call(origin, "room_wait", { hostId: "waiter-1", waitMs: 0, cursor: roomCursor }, listener.secret);
  assert.equal(wrongRoom.value.code, "invalid_wake_cursor", wrongRoom.raw);
  assert.equal(wrongRoom.value.status, 422);

  const garbage = await call(origin, "room_wait", { hostId: "waiter-1", waitMs: 0, cursor: "not-a-cursor" }, listener.secret);
  assert.equal(garbage.value.code, "invalid_wake_cursor", garbage.raw);

  // The correctly scoped cursor still works after both refusals.
  const ok = await call(origin, "room_wait", { hostId: "waiter-1", waitMs: 0, roomId: "wait-den", cursor: roomCursor }, listener.secret);
  assert.equal(ok.value.pendingWakes.length, 0, ok.raw);
});

test("an idle wait times out truthfully and a pull-only host can listen", async t => {
  const { origin, store, rooms } = await serve(t);
  const { owner, created, listener } = setup(store, rooms);
  // Consent-bound DMs: the owner asks, the listener approves.
  store.dmConsents.request("wait-den", created.ownerMemberId, "listener", "room_wait fixture");
  store.dmConsents.decide("wait-den", "listener", created.ownerMemberId, "approve");
  await call(origin, "heartbeat_set", { hostId: "puller-1", mode: "pull-only" }, listener.secret);

  const idle = await call(origin, "room_wait", { hostId: "puller-1", waitMs: 400 }, listener.secret);
  assert.equal(idle.value.timedOut, true, idle.raw);
  assert.ok(idle.value.waitedMs >= 350, `waitedMs ${idle.value.waitedMs}`);
  assert.equal(idle.value.pendingWakes.length, 0);
  assert.equal(idle.value.cursor, null);
  assert.equal(idle.value.listener.acquired, true);
  assert.equal(idle.value.receiving.status, "listening");
  assert.equal(idle.value.receiving.mode, "pull-only");

  // A DM posted mid-wait wakes the pull-only host the same way.
  const waiting = call(origin, "room_wait", { hostId: "puller-1", waitMs: 8000 }, listener.secret);
  await sleep(250);
  post(store, owner.secret, { messageId: "dm-1", body: "direct ping", toMemberId: "listener" });
  const dm = await waiting;
  assert.equal(dm.value.pendingWakes.length, 1, dm.raw);
  assert.equal(dm.value.pendingWakes[0].kind, "dm");
  assert.equal(dm.value.pendingWakes[0].message.body, "direct ping");
  assert.equal(dm.value.timedOut, false);
});

test("pendingWakePage traverses with a cursor without consuming", async t => {
  const { store, rooms } = await serve(t);
  const { listener } = setup(store, rooms);
  await store.agentHeartbeats.heartbeat({ agentId: listener.identityId, hostId: "host-1", mode: "wakeable", wakeUrl: null });
  let at = 1_700_000_000_000;
  store.now = () => at;
  const ids = [];
  for (const messageId of ["page-1", "page-2", "page-3"]) {
    ids.push(store.agentHeartbeats.enqueueWake(
      { agentId: listener.identityId, kind: "mention", roomId: "wait-den", messageId }).signal.signalId);
    at += 1000;
  }
  const page1 = store.agentHeartbeats.pendingWakePage(listener.identityId, { limit: 2, hostId: "host-1", door: "mcp" });
  assert.deepEqual(page1.signals.map(s => s.signalId), ids.slice(0, 2));
  assert.equal(page1.more, true);
  assert.ok(page1.nextCursor);
  const page2 = store.agentHeartbeats.pendingWakePage(listener.identityId,
    { limit: 2, hostId: "host-1", door: "mcp", cursor: page1.nextCursor });
  assert.deepEqual(page2.signals.map(s => s.signalId), ids.slice(2));
  assert.equal(page2.more, false);
  // Traversal consumed nothing: all three are still pending.
  assert.deepEqual(store.agentHeartbeats.pendingWakes(listener.identityId).map(s => s.signalId), ids);
  // The cursor is bound to its host scope.
  assert.throws(
    () => store.agentHeartbeats.pendingWakePage(listener.identityId, { hostId: "other-host", cursor: page1.nextCursor }),
    error => error.code === "invalid_wake_cursor" && error.status === 422);
});
