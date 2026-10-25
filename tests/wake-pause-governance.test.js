// R327-1: a pause someone else set is not the member's own stop control.
// The owner's pause on an agent can only be lifted by the owner or manage
// members; a self-set pause stays self-resumable. Fail-first for Tab's r327
// repro: agent calls resume on itself while owner-paused.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const at = Date.now(); f.store.now = () => at; f.at = () => at;
  return f;
}

async function httpFixture(t) {
  const f = fixture(t);
  const server = createRoomServer({ store: f.store });
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  f.call = (path, { method = "GET", data, as } = {}) => fetch(`${origin}${path}`, {
    method,
    headers: { Origin: origin, ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...(typeof as === "string" ? { Authorization: `Bearer ${as}` } : {}) },
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

test("HTTP: the owner's pause on an agent is lifted only by the owner or manage members", async t => {
  const f = await httpFixture(t);
  await f.pause(f.keys.owner, "producer", "review first");
  await errorCode(await f.resume(f.keys.producer, "producer"), 403, "wake_pause_held_by_owner");
  // The pause survives the refused resume: producer stays stopped.
  const view = await (await f.inspect(f.keys.owner, "producer")).json();
  assert.equal(view.pause.reason, "review first");
  assert.equal(view.pause.pausedBy, "owner");
  // The owner lifts it; the self-set case is untouched.
  const ownerLift = await f.resume(f.keys.owner, "producer");
  assert.equal(ownerLift.status, 201);
  assert.equal((await ownerLift.json()).receipt.wasPaused, true);
  assert.equal((await (await f.inspect(f.keys.owner, "producer")).json()).pause, null);
});

test("HTTP: a pause the member set itself stays self-resumable", async t => {
  const f = await httpFixture(t);
  const self = await f.pause(f.keys.producer, "producer", "own maintenance");
  assert.equal(self.status, 201);
  const lift = await f.resume(f.keys.producer, "producer");
  assert.equal(lift.status, 201);
  assert.equal((await lift.json()).receipt.wasPaused, true);
});

test("HTTP: a governor pause over an existing self-set pause takes the pause over", async t => {
  const f = await httpFixture(t);
  await f.pause(f.keys.producer, "producer", "own maintenance");
  await f.pause(f.keys.owner, "producer", "room freeze");
  assert.equal(f.store.wakeQueue.pausedBy("commons", "producer"), "owner");
  await errorCode(await f.resume(f.keys.producer, "producer"), 403, "wake_pause_held_by_owner");
  const lift = await f.resume(f.keys.owner, "producer");
  assert.equal(lift.status, 201);
});

test("HTTP: manage members can lift a pause they did not set; the roster names the setter", async t => {
  const f = await httpFixture(t);
  await f.pause(f.keys.owner, "guest", "inspecting");
  await errorCode(await f.resume(f.keys.producer, "guest"), 403, "wake_pause_not_permitted");
  const reviewer = f.store.room("commons").state.members.reviewer;
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: (await import("../src/events.js")).EVENT_TYPES.MEMBER_ACCESS_CHANGED, data: {
    memberId: "reviewer", expectedMemberRevision: reviewer.revision,
    permissions: [...new Set([...(reviewer.permissions ?? []), "manage_members"])], active: true,
  } });
  const delegated = await f.resume(f.keys.reviewer, "guest");
  assert.equal(delegated.status, 201);
  const roster = (await (await f.inspect(f.keys.owner)).json()).paused;
  assert.deepEqual(roster.map(p => [p.memberId, p.pausedBy]), [], "the lifted row leaves the roster");
});


test("HTTP: a manage-members pause on itself stays self-held and self-resumable after the permission is revoked", async t => {
  const f = await httpFixture(t);
  const { EVENT_TYPES: T } = await import("../src/events.js");
  const grant = (permissions) => {
    const reviewer = f.store.room("commons").state.members.reviewer;
    f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: {
      memberId: "reviewer", expectedMemberRevision: reviewer.revision, permissions, active: true,
    } });
  };
  const reviewerPermissions = () => f.store.room("commons").state.members.reviewer.permissions ?? [];
  grant([...new Set([...reviewerPermissions(), "manage_members"])]);
  const self = await f.pause(f.keys.reviewer, "reviewer", "own maintenance");
  assert.equal(self.status, 201, "the reviewer pauses itself");
  assert.equal((await self.json()).receipt.heldBy, "self", "a member-set pause is self-held, not owner-held");
  assert.equal(f.store.wakeQueue.heldByOf("commons", "reviewer"), "self");
  grant(reviewerPermissions().filter(p => p !== "manage_members"));
  const lift = await f.resume(f.keys.reviewer, "reviewer");
  assert.equal(lift.status, 201, "revoking the permission cannot strand the member's own pause");
  assert.equal((await lift.json()).receipt.wasPaused, true);
  assert.equal((await (await f.inspect(f.keys.owner)).json()).pause, null);
});

test("HTTP: a governor pause over an existing self-set pause still hardens; the member cannot soften it back", async t => {
  const f = await httpFixture(t);
  await f.pause(f.keys.producer, "producer", "own maintenance");
  const reviewer = f.store.room("commons").state.members.reviewer;
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: (await import("../src/events.js")).EVENT_TYPES.MEMBER_ACCESS_CHANGED, data: {
    memberId: "reviewer", expectedMemberRevision: reviewer.revision,
    permissions: [...new Set([...(reviewer.permissions ?? []), "manage_members"])], active: true,
  } });
  // A governor re-pausing ITSELF must not harden its own row.
  const own = await f.pause(f.keys.reviewer, "reviewer", "own maintenance");
  assert.equal((await own.json()).receipt.heldBy, "self", "a governor's self-pause is self-held");
  // But a governor over another member's self-pause takes it over.
  await f.pause(f.keys.reviewer, "producer", "review first");
  assert.equal(f.store.wakeQueue.heldByOf("commons", "producer"), "owner");
  await errorCode(await f.resume(f.keys.producer, "producer"), 403, "wake_pause_held_by_owner");
  // And the member cannot soften the hardened row by re-pausing itself.
  await f.pause(f.keys.producer, "producer", "own maintenance");
  assert.equal(f.store.wakeQueue.heldByOf("commons", "producer"), "owner");
  await errorCode(await f.resume(f.keys.producer, "producer"), 403, "wake_pause_held_by_owner");
  assert.equal((await f.resume(f.keys.reviewer, "producer")).status, 201);
});

test("legacy pause row with no setter record fails closed", async t => {
  const f = await httpFixture(t);
  await f.pause(f.keys.owner, "producer", "inspecting");
  f.store.db.prepare("DELETE FROM wake_queue_pause_by WHERE room_id='commons' AND member_id='producer'").run();
  await errorCode(await f.resume(f.keys.producer, "producer"), 403, "wake_pause_held_by_owner");
  assert.equal(f.store.wakeQueue.pausedBy("commons", "producer"), null);
  assert.notEqual(f.store.wakeQueue.pauseStatus("commons", "producer"), null, "the legacy pause still holds");
});
