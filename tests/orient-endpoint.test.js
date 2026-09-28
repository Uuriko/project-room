// Orient endpoint (jill lane, RC-2026-09-28 — ryska's 404): the URL outside
// agents guess by analogy with /activation-pack now serves a read-only,
// member-scoped orientation payload. Tests run against a real RoomStore
// and a real HTTP server: payload shape/fields, member scoping, 404 on
// unknown room, 401 unauthenticated.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { buildOrient } from "../server/orient.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event } from "../src/events.js";

const ROOM = "orient-demo";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-orient-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: ROOM,
      data: { roomId: ROOM, ownerId: "owner", title: "Orient Demo",
        purpose: "Fixture room for the orient endpoint.", kind: "personal" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: ROOM,
      data: { memberId: "owner", displayName: "Room owner", kind: "human",
        permissions: [...PERMISSIONS] } })
  ]);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  store.command(ownerKey, ROOM, { id: "orient-add-worker", type: T.MEMBER_ADDED, data: {
    memberId: "worker", displayName: "Orient Worker", kind: "agent",
    permissions: ["accept_work", "write_external", "complete_work"], accountableHumanId: "owner" } });
  const workerKey = store.issueAccessKey(ROOM, "worker");
  // Write-mode work, accepted by the worker, unclaimed: the next step is "claim".
  store.command(ownerKey, ROOM, { id: "orient-propose", type: T.WORK_PROPOSED, data: {
    workItemId: "orient-work-1", title: "Fix the orient 404",
    definitionOfDone: "GET /orient returns 200.", accountableMemberId: "worker",
    verifierMemberId: "owner", mode: "write" } });
  store.command(workerKey, ROOM, { id: "orient-accept", type: T.WORK_ACCEPTED, data: {
    workItemId: "orient-work-1", expectedRevision: 0 } });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, workerKey };
}

async function serve(t, store) {
  const server = createRoomServer({ store });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return origin;
}

const getOrient = (origin, roomId, token) =>
  fetch(`${origin}/api/rooms/${roomId}/orient`, token
    ? { headers: { Authorization: `Bearer ${token}` } } : {});

test("orient serves the member-scoped payload", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const response = await getOrient(origin, ROOM, f.workerKey);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload).sort(), ["contract", "evaluatedThrough", "eventCursor",
    "generatedAt", "links", "member", "orientation", "room", "work", "workTotal"]);
  assert.deepEqual(payload.contract, { name: "project-room/orient", version: 1 });
  assert.deepEqual(payload.room, { slug: ROOM, title: "Orient Demo", state: "active", kind: "personal" });
  // The caller sees their own member record and scope, nobody else's.
  assert.equal(payload.member.id, "worker");
  assert.equal(payload.member.handle, "Orient Worker");
  assert.equal(payload.member.kind, "agent");
  assert.deepEqual(payload.member.permissions, ["accept_work", "write_external", "complete_work"]);
  assert.ok(Number.isSafeInteger(payload.evaluatedThrough) && payload.evaluatedThrough > 0);
  assert.ok(typeof payload.eventCursor === "string" && payload.eventCursor.length > 0);
  assert.equal(payload.orientation.purpose, "Fixture room for the orient endpoint.");
  assert.equal(payload.workTotal, 1);
  assert.equal(payload.work.length, 1);
  const item = payload.work[0];
  assert.equal(item.id, "orient-work-1");
  assert.equal(item.title, "Fix the orient 404");
  assert.equal(item.state, "accepted");
  assert.equal(item.claimant, null);
  assert.equal(item.next.action, "claim");
  assert.equal(item.next.memberId, "worker");
  assert.equal(typeof item.next.needsAttention, "boolean");
  assert.equal(payload.links.activationPack, `/api/rooms/${ROOM}/activation-pack`);
  assert.ok(!Number.isNaN(Date.parse(payload.generatedAt)));
});

test("orient scopes the member record to the caller", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const payload = await (await getOrient(origin, ROOM, f.ownerKey)).json();
  assert.equal(payload.member.id, "owner");
  assert.equal(payload.member.handle, "Room owner");
  assert.equal(payload.member.kind, "human");
  assert.ok(payload.member.permissions.includes("manage_members"));
});

test("unknown room answers 404 room_not_found", () => {
  const store = new RoomStore(":memory:");
  try {
    assert.throws(() => buildOrient(store, "no-such-room", "owner"),
      error => error.status === 404 && error.code === "room_not_found");
  } finally { store.close(); }
});

test("orient rejects unauthenticated callers", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const response = await getOrient(origin, ROOM, null);
  assert.equal(response.status, 401);
});

test("buildOrient matches the served payload", async t => {
  const f = fixture(t);
  const direct = buildOrient(f.store, ROOM, "worker");
  assert.deepEqual(direct.contract, { name: "project-room/orient", version: 1 });
  assert.equal(direct.member.id, "worker");
  assert.equal(direct.workTotal, 1);
});
