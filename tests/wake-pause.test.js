// W4-48 H7: pause and inspect - one stop surface over the wake queue.
// Done-when: pending and already-running attempts are distinguished.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { surfaceClass } from "../server/action-classes.mjs";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  let at = Date.now(); f.store.now = () => at; f.at = () => at; f.advance = ms => { at += ms; };
  f.enqueue = (extra = {}, actor = "owner") => f.store.wakeQueue.enqueue(f.keys[actor], "commons",
    { requestId: randomUUID(), queueKey: "recipe:draft-catch-up", intent: { recipe: "draft-catch-up" }, dueAt: at, maxAttempts: 3, ...extra });
  f.view = (actor = "owner") => f.store.wakeQueue.list(f.keys[actor], "commons");
  return f;
}

test("pause and resume validate, retry idempotently and are the member's own", t => {
  const f = fixture(t);
  assert.throws(() => f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: "bad id!", reason: null }));
  assert.throws(() => f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: randomUUID(), reason: "x".repeat(201) }));
  assert.throws(() => f.store.wakeQueue.resume(f.keys.owner, "commons", { requestId: randomUUID(), extra: true }));
  const paused = f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: randomUUID(), reason: "inspecting" });
  assert.equal(paused.receipt.state, "paused");
  assert.equal(paused.receipt.alreadyPaused, false);
  assert.equal(paused.pause.reason, "inspecting");
  const again = f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: randomUUID(), reason: "still" });
  assert.equal(again.receipt.alreadyPaused, true, "re-pause keeps the original pause");
  assert.equal(f.view().pause.reason, "inspecting");
  const retry = f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: paused.receipt.requestId, reason: "inspecting" });
  assert.equal(retry.duplicate, true, "exact retry returns the historical receipt");
  assert.equal(f.view("guest").pause, null, "pause is private per member");
  const resumed = f.store.wakeQueue.resume(f.keys.owner, "commons", { requestId: randomUUID() });
  assert.equal(resumed.receipt.wasPaused, true);
  assert.equal(f.view().pause, null);
  const twice = f.store.wakeQueue.resume(f.keys.owner, "commons", { requestId: randomUUID() });
  assert.equal(twice.receipt.wasPaused, false, "resume without a pause is a no-op, not an error");
});

test("done-when: while paused no pending attempt starts, an already-running attempt is distinguished and finishes", t => {
  const f = fixture(t);
  f.enqueue();
  const running = f.store.wakeQueue.lease("commons", "owner", "recipe:draft-catch-up", "worker-1");
  assert.ok(running, "wake leased before the pause: already running");
  f.enqueue({ queueKey: "recipe:request-review" }, "owner");
  f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: randomUUID(), reason: "look before more" });
  // The stop surface distinguishes: one running, one pending.
  const view = f.view();
  assert.deepEqual(view.running.map(w => w.queueKey), ["recipe:draft-catch-up"]);
  assert.deepEqual(view.pending.map(w => w.queueKey), ["recipe:request-review"]);
  assert.equal(view.pause.reason, "look before more");
  // No new attempt starts while paused, even when due.
  assert.deepEqual(f.store.wakeQueue.due(f.at()).map(w => w.queueKey), [], "paused member's pending wake is not leasable");
  assert.equal(f.store.wakeQueue.lease("commons", "owner", "recipe:request-review", "worker-1"), null);
  // The already-running attempt is not interrupted: it completes normally.
  const done = f.store.wakeQueue.complete("commons", "owner", "recipe:draft-catch-up", { requestId: randomUUID(), leaseOwner: "worker-1", effect: { draft: true } });
  assert.equal(done.receipt.state, "done");
  // Recent outcomes are readable: the completion shows with its attempt count.
  const after = f.view();
  assert.deepEqual(after.recentOutcomes.map(o => [o.queueKey, o.state, o.attempts]), [["recipe:draft-catch-up", "done", 1]]);
  assert.equal(after.running.length, 0);
  // Resume lets the pending wake start again.
  f.store.wakeQueue.resume(f.keys.owner, "commons", { requestId: randomUUID() });
  assert.deepEqual(f.store.wakeQueue.due(f.at()).map(w => w.queueKey), ["recipe:request-review"]);
});

test("a paused member's dead-letter and failed attempts stay inspectable, other members are unaffected", t => {
  const f = fixture(t);
  f.enqueue({ maxAttempts: 1 });
  f.store.wakeQueue.lease("commons", "owner", "recipe:draft-catch-up", "worker-1");
  const failed = f.store.wakeQueue.fail("commons", "owner", "recipe:draft-catch-up", { leaseOwner: "worker-1", error: "boom" });
  assert.equal(failed.state, "dead");
  f.enqueue({}, "guest");
  f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: randomUUID(), reason: null });
  const view = f.view();
  assert.deepEqual(view.recentOutcomes.map(o => [o.queueKey, o.state, o.lastError]), [["recipe:draft-catch-up", "dead", "boom"]]);
  assert.deepEqual(f.store.wakeQueue.due(f.at()).map(w => w.queueKey), ["recipe:draft-catch-up"], "guest's due wake is unaffected by the owner's pause");
  assert.equal(surfaceClass("wake-queue"), "draft", "the stop surface stays draft class: no sends, no spend");
});

// C6: the owner-facing HTTP surface over the same pause rows.
// POST/GET /api/rooms/:id/agent-pause - a member acts on its own row; the
// signed-in owner acts on any member's; a removed member's row is inert.
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function httpFixture(t) {
  const f = fixture(t);
  const server = createRoomServer({ store: f.store });
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Browser sessions for humans (cookie + CSRF + binding); bearer keys for agents.
  f.login = async actor => {
    const response = await fetch(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: f.keys[actor] }) });
    assert.equal(response.status, 201);
    return { cookie: response.headers.get("set-cookie").split(";")[0], session: await response.json() };
  };
  f.call = (path, { method = "GET", data, as } = {}) => fetch(`${origin}${path}`, {
    method,
    headers: { Origin: origin, ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...(typeof as === "string" ? { Authorization: `Bearer ${as}` }
        : as ? { Cookie: as.cookie, "X-CSRF-Token": as.session.csrf, "X-Session-Binding": as.session.sessionBinding } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  f.pause = (as, memberId, reason = null) => f.call("/api/rooms/commons/agent-pause", { method: "POST", as, data: { action: "pause", memberId, requestId: randomUUID(), reason } });
  f.resume = (as, memberId) => f.call("/api/rooms/commons/agent-pause", { method: "POST", as, data: { action: "resume", memberId, requestId: randomUUID() } });
  f.inspect = (as, memberId = null) => f.call(`/api/rooms/commons/agent-pause${memberId ? `?memberId=${encodeURIComponent(memberId)}` : ""}`, { as });
  return f;
}
const errorCode = async (response, status, code) => {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  return body;
};

test("HTTP: only the signed-in owner pauses another member; a member pauses itself", async t => {
  const f = await httpFixture(t);
  const owner = await f.login("owner"), guest = await f.login("guest");
  await errorCode(await f.pause(guest, "producer"), 403, "owner_required");
  await errorCode(await f.pause(f.keys.producer, "reviewer"), 403, "owner_required");
  await errorCode(await f.inspect(guest, "producer"), 403, "owner_required");
  await errorCode(await f.pause(owner, "nobody"), 404, "member_not_found");
  const self = await f.pause(f.keys.producer, "producer", "own maintenance");
  assert.equal(self.status, 201);
  const selfBody = await self.json();
  assert.equal(selfBody.receipt.state, "paused");
  assert.equal(selfBody.memberId, "producer");
  assert.equal(selfBody.viewerId, "producer");
  assert.equal("paused" in selfBody, false, "a non-owner never receives the room roster");
  const paused = await f.pause(owner, "reviewer", "inspecting");
  assert.equal(paused.status, 201);
  const body = await paused.json();
  assert.equal(body.memberId, "reviewer");
  assert.equal(body.viewerId, "owner");
  assert.equal(body.pause.reason, "inspecting");
  assert.deepEqual(body.paused.map(p => p.memberId), ["producer", "reviewer"], "the owner sees the whole paused roster");
  const guestView = await f.inspect(guest);
  assert.equal(guestView.status, 200);
  const guestBody = await guestView.json();
  assert.equal(guestBody.memberId, "guest");
  assert.equal(guestBody.pause, null);
  assert.equal("paused" in guestBody, false);
  assert.equal(f.store.wakeQueue.pauseStatus("commons", "reviewer").reason, "inspecting");
  assert.equal(f.store.wakeQueue.pauseStatus("commons", "guest"), null);
});

test("HTTP: a paused agent's queued wake does not start until the owner resumes it", async t => {
  const f = await httpFixture(t);
  const owner = await f.login("owner");
  f.enqueue({}, "producer");
  assert.deepEqual(f.store.wakeQueue.due(f.at()).map(w => [w.queueKey]), [["recipe:draft-catch-up"]]);
  assert.equal((await f.pause(owner, "producer", "look first")).status, 201);
  assert.deepEqual(f.store.wakeQueue.due(f.at()), [], "paused: the due wake is not leasable");
  assert.equal(f.store.wakeQueue.lease("commons", "producer", "recipe:draft-catch-up", "worker-1"), null);
  const view = await (await f.inspect(owner, "producer")).json();
  assert.deepEqual(view.pending.map(w => w.queueKey), ["recipe:draft-catch-up"]);
  assert.equal(view.running.length, 0);
  assert.equal(view.pause.reason, "look first");
  const resumed = await f.resume(owner, "producer");
  assert.equal(resumed.status, 201);
  assert.equal((await resumed.json()).receipt.wasPaused, true);
  assert.deepEqual(f.store.wakeQueue.due(f.at()).map(w => w.queueKey), ["recipe:draft-catch-up"]);
  assert.ok(f.store.wakeQueue.lease("commons", "producer", "recipe:draft-catch-up", "worker-1"), "resumed: the wake starts");
});

test("HTTP: a removed member's pause row is inert - inspectable, unchangeable, and it never restarts wakes", async t => {
  const f = await httpFixture(t);
  const owner = await f.login("owner");
  f.enqueue({}, "producer");
  assert.equal((await f.pause(owner, "producer", "before removal")).status, 201);
  const producer = f.store.room("commons").state.members.producer;
  const removed = await f.call("/api/rooms/commons/commands", { method: "POST", as: owner, data: { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "producer", expectedMemberRevision: producer.revision, permissions: [...producer.permissions], active: false } } });
  assert.equal(removed.status, 201);
  assert.equal(f.store.room("commons").state.members.producer.active, false);
  await errorCode(await f.inspect(f.keys.producer), 401, "unauthenticated");
  await errorCode(await f.resume(f.keys.producer, "producer"), 401, "unauthenticated");
  const view = await (await f.inspect(owner, "producer")).json();
  assert.equal(view.pause.reason, "before removal", "the owner still sees the row");
  await errorCode(await f.resume(owner, "producer"), 409, "member_inactive");
  await errorCode(await f.pause(owner, "producer"), 409, "member_inactive");
  assert.equal(f.store.wakeQueue.pauseStatus("commons", "producer").reason, "before removal");
  assert.equal(f.store.room("commons").state.members.producer.active, false, "the pause row never reactivates a member");
  assert.deepEqual(f.store.wakeQueue.due(f.at()), [], "a removed member's queued wake does not start");
});

test("HTTP: unauthenticated and malformed requests are refused; responses carry no credential material", async t => {
  const f = await httpFixture(t);
  await errorCode(await f.call("/api/rooms/commons/agent-pause"), 401, "unauthenticated");
  await errorCode(await f.pause(undefined, "producer"), 401, "unauthenticated");
  await errorCode(await f.pause("A".repeat(43), "producer"), 401, "unauthenticated");
  const owner = await f.login("owner");
  await errorCode(await f.call("/api/rooms/commons/agent-pause", { method: "POST", as: owner, data: { action: "pause", memberId: "producer", requestId: randomUUID() } }), 422, "invalid_pause_command");
  await errorCode(await f.call("/api/rooms/commons/agent-pause", { method: "POST", as: owner, data: { action: "stop", memberId: "producer", requestId: randomUUID() } }), 422, "invalid_pause_command");
  await errorCode(await f.call("/api/rooms/commons/agent-pause?memberId=a&memberId=b", { as: owner }), 422, "invalid_pause_selection");
  await errorCode(await f.call("/api/rooms/commons/agent-pause", { method: "POST", as: { cookie: owner.cookie, session: { csrf: "0".repeat(64), sessionBinding: owner.session.sessionBinding } }, data: { action: "resume", memberId: "producer", requestId: randomUUID() } }), 403, "csrf_denied");
  const responses = [await f.pause(owner, "producer", "audit"), await f.inspect(owner, "producer"), await f.inspect(owner), await f.pause(f.keys.reviewer, "reviewer"), await f.resume(owner, "producer")];
  for (const response of responses) {
    assert.ok([200, 201].includes(response.status));
    const raw = await response.text();
    for (const secret of [...Object.values(f.keys), owner.cookie.split("=")[1], owner.session.csrf, owner.session.sessionBinding]) {
      assert.equal(raw.includes(secret), false, "pause responses never carry keys, cookies, CSRF tokens or bindings");
    }
    assert.doesNotMatch(raw, /"(token|accessKey|csrf|sessionBinding|credentialHash)"/);
  }
});
