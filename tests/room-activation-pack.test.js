// Room activation pack (quill lane, RC-2026-09-18-040): one machine-readable
// fetch giving an agent everything it needs to start working. Tests run
// against a real RoomStore and a real HTTP server: pack shape/fields,
// 404 on unknown room, member roster, work items with claim state, pinned
// resources, and the coordination-norm defaults.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { buildActivationPack, COORDINATION_NORMS } from "../server/room-activation-pack.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event } from "../src/events.js";

const ROOM = "activation-demo";
const FUTURE_LEASE = new Date(Date.now() + 6 * 3600 * 1000).toISOString();

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-activation-pack-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: ROOM,
      data: { roomId: ROOM, ownerId: "owner", title: "Activation Demo",
        purpose: "Fixture room for the activation pack.", kind: "personal" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: ROOM,
      data: { memberId: "owner", displayName: "Room owner", kind: "human",
        permissions: [...PERMISSIONS] } })
  ]);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  store.command(ownerKey, ROOM, { id: "pack-add-worker", type: T.MEMBER_ADDED, data: {
    memberId: "worker", displayName: "Pack Worker", kind: "agent",
    permissions: ["accept_work", "write_external", "complete_work"], accountableHumanId: "owner" } });
  const workerKey = store.issueAccessKey(ROOM, "worker");
  store.command(ownerKey, ROOM, { id: "pack-policy", type: T.ROOM_POLICY_SET, data: {
    requireIndependentReview: true, requireOwnerDecision: false } });
  store.command(ownerKey, ROOM, { id: "pack-msg", type: T.MESSAGE_POSTED, data: {
    messageId: "pack-pin-src", body: "Start here: the activation pack README." } });
  store.command(ownerKey, ROOM, { id: "pack-pin", type: T.MESSAGE_PINNED, data: {
    messageId: "pack-pin-src" } });
  // Write-mode work, accepted and actively claimed by the worker.
  store.command(ownerKey, ROOM, { id: "pack-propose-1", type: T.WORK_PROPOSED, data: {
    workItemId: "pack-work-1", title: "Wire the activation pack",
    definitionOfDone: "Endpoint serves the pack.", accountableMemberId: "worker",
    verifierMemberId: "owner", mode: "write" } });
  store.command(workerKey, ROOM, { id: "pack-accept-1", type: T.WORK_ACCEPTED, data: {
    workItemId: "pack-work-1", expectedRevision: 0 } });
  store.command(workerKey, ROOM, { id: "pack-claim-1", type: T.CLAIM_ACQUIRED, data: {
    workItemId: "pack-work-1", expectedRevision: 1, repository: "pack-repo", ref: "main",
    paths: ["server/room-activation-pack.mjs"], expiresAt: FUTURE_LEASE } });
  // Read-mode work, accepted, unclaimed.
  store.command(ownerKey, ROOM, { id: "pack-propose-2", type: T.WORK_PROPOSED, data: {
    workItemId: "pack-work-2", title: "Document the norms",
    definitionOfDone: "Norms doc merged.", accountableMemberId: "worker",
    verifierMemberId: "owner", mode: "read" } });
  store.command(workerKey, ROOM, { id: "pack-accept-2", type: T.WORK_ACCEPTED, data: {
    workItemId: "pack-work-2", expectedRevision: 0 } });
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

const getPack = (origin, roomId, token) =>
  fetch(`${origin}/api/rooms/${roomId}/activation-pack`, { headers: { Authorization: `Bearer ${token}` } });

test("pack shape: every documented field is present", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const response = await getPack(origin, ROOM, f.ownerKey);
  assert.equal(response.status, 200);
  const pack = await response.json();
  assert.deepEqual(Object.keys(pack).sort(), ["coordinationNorms", "eventCursor", "generatedAt", "members",
    "openWork", "participationRules", "pinnedResources", "repoHead", "room"]);
  assert.deepEqual(pack.room, { slug: ROOM, title: "Activation Demo", state: "active",
    kind: "personal", owner: "owner" });
  assert.equal(pack.repoHead, null);
  assert.ok(typeof pack.eventCursor === "string" && pack.eventCursor.length > 0);
  const cursor = JSON.parse(Buffer.from(pack.eventCursor, "base64url").toString("utf8"));
  assert.equal(cursor.v, 1);
  assert.ok(Number.isSafeInteger(cursor.seq) && cursor.seq > 0);
  assert.ok(!Number.isNaN(Date.parse(pack.generatedAt)));
});

test("unknown room answers 404 room_not_found", () => {
  const store = new RoomStore(":memory:");
  try {
    assert.throws(() => buildActivationPack(store, "no-such-room"),
      error => error.status === 404 && error.code === "room_not_found");
  } finally { store.close(); }
});

test("member roster carries identity, handle, kind and permissions", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const pack = await (await getPack(origin, ROOM, f.workerKey)).json();
  const byId = Object.fromEntries(pack.members.map(member => [member.id, member]));
  assert.deepEqual(Object.keys(byId).sort(), ["owner", "worker"]);
  assert.deepEqual(byId.owner, { id: "owner", identityId: null, handle: "Room owner",
    kind: "human", permissions: [...PERMISSIONS] });
  assert.equal(byId.worker.identityId, null);
  assert.equal(byId.worker.handle, "Pack Worker");
  assert.equal(byId.worker.kind, "agent");
  assert.deepEqual(byId.worker.permissions, ["accept_work", "write_external", "complete_work"]);
});

test("open work lists claimants, claim statuses and lease expiries", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const pack = await (await getPack(origin, ROOM, f.ownerKey)).json();
  assert.equal(pack.openWork.length, 2);
  const [claimed, unclaimed] = pack.openWork;
  assert.deepEqual(claimed, { id: "pack-work-1", title: "Wire the activation pack",
    state: "accepted", claimant: "worker", claimStatus: "active", deliveryMode: "write",
    reviewPolicy: "independent", leaseExpiresAt: FUTURE_LEASE });
  assert.deepEqual(unclaimed, { id: "pack-work-2", title: "Document the norms",
    state: "accepted", claimant: null, claimStatus: null, deliveryMode: "read",
    reviewPolicy: "independent", leaseExpiresAt: null });
});

test("pinned resources and participation rules are real room data", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const pack = await (await getPack(origin, ROOM, f.ownerKey)).json();
  assert.equal(pack.pinnedResources.length, 1);
  assert.deepEqual(pack.pinnedResources[0], { messageId: "pack-pin-src", pinnedById: "owner",
    pinnedAt: pack.pinnedResources[0].pinnedAt, authorId: "owner",
    body: "Start here: the activation pack README." });
  assert.ok(!Number.isNaN(Date.parse(pack.pinnedResources[0].pinnedAt)));
  assert.deepEqual(pack.participationRules, { requireIndependentReview: true, requireOwnerDecision: false });
});

test("coordination norms carry the standing defaults", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const pack = await (await getPack(origin, ROOM, f.ownerKey)).json();
  assert.deepEqual(pack.coordinationNorms, { maxClaimsPerAgentPerCycle: 1,
    releaseOnInactivityHours: 24, stopAfterRepeatedNoopWakes: true });
  assert.deepEqual(pack.coordinationNorms, { ...COORDINATION_NORMS });
  assert.ok(Object.isFrozen(COORDINATION_NORMS));
});

test("the route rides the standard room credential funnel", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const anonymous = await fetch(`${origin}/api/rooms/${ROOM}/activation-pack`);
  assert.equal(anonymous.status, 401);
});
