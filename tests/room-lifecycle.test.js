// Issue #6 A2: room lifecycle — archive (owner-only, closes the log), leave
// (a member ends their own access), the personal/organization kind, and the
// v28 migration that adds rooms.archived_at to genuine v27 data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { frozenRecoveryFixture, v27LifecycleBaseline } from "../scripts/frozen-runtime-fixture.mjs";
import { RoomStore, COMMAND_TYPES } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { classifyCommand } from "../server/action-classes.mjs";
import { migrateRoomLifecycleV28, verifyRoomLifecycle } from "../server/room-lifecycle.mjs";
import { STORE_SCHEMA_VERSION, registerWriter } from "../server/writer-fence.mjs";
import { applyEvent, emptyRoomState, event, EVENT_TYPES as T, PERMISSIONS, ROOM_KINDS, roomKind, isRoomArchived, isLeaveRequest } from "../src/events.js";

const owner = "owner";
const seed = (roomId, extra = {}) => [
  event({ type: T.ROOM_CREATED, actorId: owner, roomId, data: { roomId, ownerId: owner, title: "Lifecycle", purpose: "Synthetic lifecycle test", ...extra } }),
  event({ type: T.MEMBER_ADDED, actorId: owner, roomId, data: { memberId: owner, displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } }),
  event({ type: T.MEMBER_ADDED, actorId: owner, roomId, data: { memberId: "m", displayName: "Member", kind: "human", permissions: ["steer"] } })
];
const access = (actorId, memberId, permissions, active = false) => event({ type: T.MEMBER_ACCESS_CHANGED, actorId, roomId: "r",
  data: { memberId, expectedMemberRevision: 0, permissions, active } });

test("reducer: kind is validated at creation, archive is owner-only and closes the log, leaving needs no administration", () => {
  assert.equal(STORE_SCHEMA_VERSION, 35);
  assert.deepEqual([...ROOM_KINDS], ["personal", "organization"]);
  assert.ok(COMMAND_TYPES.includes(T.ROOM_ARCHIVED)); assert.equal(classifyCommand(T.ROOM_ARCHIVED), "act");
  const state = seed("r").reduce(applyEvent, emptyRoomState());
  assert.equal(roomKind(state.room), "personal", "rooms from before the kind attribute read as personal");
  assert.equal(isRoomArchived(state), false);
  assert.throws(() => seed("k", { kind: "team" }).reduce(applyEvent, emptyRoomState()), /personal or organization/);
  assert.equal(roomKind(seed("k", { kind: "organization" }).reduce(applyEvent, emptyRoomState()).room), "organization");
  // Leave: the actor ends their own access with unchanged permissions.
  const leave = access("m", "m", ["steer"]);
  assert.equal(isLeaveRequest(state, leave), true);
  assert.equal(applyEvent(state, leave).members.m.active, false);
  // Not a leave: changing one's own permissions, deactivating someone else, or leaving twice.
  assert.throws(() => applyEvent(state, access("m", "m", [])), /lacks manage_members/);
  assert.throws(() => applyEvent(state, access("m", owner, [...PERMISSIONS])), /lacks manage_members/);
  assert.equal(isLeaveRequest(applyEvent(state, leave), { ...leave, id: randomUUID(), idempotencyKey: randomUUID() }), false, "an inactive member has nothing to leave");
  assert.throws(() => applyEvent(state, access(owner, owner, [...PERMISSIONS])), /Owner must retain membership administration/);
  // Archive: owner only, bounded reason, then nothing else is accepted.
  assert.throws(() => applyEvent(state, event({ type: T.ROOM_ARCHIVED, actorId: "m", roomId: "r", data: {} })), /Only the Room owner may archive/);
  assert.throws(() => applyEvent(state, event({ type: T.ROOM_ARCHIVED, actorId: owner, roomId: "r", data: { reason: "x".repeat(281) } })), /280 characters/);
  const archive = event({ type: T.ROOM_ARCHIVED, actorId: owner, roomId: "r", data: { reason: "Pilot finished" } });
  const archived = applyEvent(state, archive);
  assert.equal(archived.room.archivedAt, archive.at); assert.equal(archived.room.archivedById, owner); assert.equal(archived.room.archiveReason, "Pilot finished");
  assert.equal(isRoomArchived(archived), true);
  for (const later of [event({ type: T.MESSAGE_POSTED, actorId: owner, roomId: "r", data: { messageId: "late", body: "Too late" } }),
    event({ type: T.ROOM_ARCHIVED, actorId: owner, roomId: "r", data: {} }), leave]) {
    assert.throws(() => applyEvent(archived, later), /Room is archived/);
  }
  assert.deepEqual(applyEvent(archived, archive), archived, "replaying the recorded archive event is idempotent");
  const plain = applyEvent(state, event({ type: T.ROOM_ARCHIVED, actorId: owner, roomId: "r", data: {} })).room;
  assert.equal(Object.hasOwn(plain, "archiveReason"), false, "no reason key without a reason");
});

async function serve(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port;
}

test("store: archiving closes commands, import and every join path with 409 room_archived while reads and export continue", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = await serve(t, f);
  const post = (key, command) => fetch(origin + "/api/rooms/commons/commands", { method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const invite = f.store.invites.create(f.keys.owner, "commons", { permissions: ["accept_work"], displayName: "Late agent" });
  let res = await post(f.keys.guest, { id: randomUUID(), type: T.ROOM_ARCHIVED, data: {} });
  assert.equal(res.status, 422); assert.equal((await res.json()).error.code, "command_rejected");
  res = await post(f.keys.owner, { id: randomUUID(), type: T.ROOM_ARCHIVED, data: { note: "x" } });
  assert.equal(res.status, 422); assert.equal((await res.json()).error.code, "invalid_command");
  const before = f.store.room("commons").sequence;
  const archive = { id: randomUUID(), type: T.ROOM_ARCHIVED, data: { reason: "Pilot ended" } };
  res = await post(f.keys.owner, archive); assert.equal(res.status, 201);
  const receipt = await res.json();
  assert.equal(receipt.event.type, T.ROOM_ARCHIVED); assert.equal(f.store.room("commons").sequence, before + 1);
  assert.equal(f.store.room("commons").state.room.archivedAt, receipt.event.at);
  assert.equal(f.store.db.prepare("SELECT archived_at FROM rooms WHERE id='commons'").get().archived_at, receipt.event.at, "the column mirrors the projection");
  res = await post(f.keys.owner, archive); assert.equal(res.status, 200); assert.equal((await res.json()).duplicate, true, "an exact retry keeps its receipt");
  const guest = f.store.room("commons").state.members.guest;
  for (const [key, command] of [
    [f.keys.owner, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "late", body: "Too late" } }],
    [f.keys.owner, { id: randomUUID(), type: T.ROOM_ARCHIVED, data: {} }],
    [f.keys.guest, { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: { memberId: "guest", expectedMemberRevision: guest.revision, permissions: [...guest.permissions], active: false } }],
    [f.keys.producer, { id: randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId: "test-handoff", expectedRevision: 0 } }]
  ]) {
    res = await post(key, command); assert.equal(res.status, 409);
    const body = await res.json(); assert.equal(body.error.code, "room_archived"); assert.match(body.error.message, /export/);
  }
  assert.equal(f.store.room("commons").sequence, before + 1, "nothing was recorded");
  const lines = [...f.store.exportEvents(f.keys.owner, "commons")];
  assert.equal(lines.at(-1).event.type, T.ROOM_ARCHIVED, "export includes the archive event");
  res = await fetch(origin + "/api/rooms/commons/import", { method: "POST", headers: { Authorization: "Bearer " + f.keys.owner, "Content-Type": "application/x-ndjson" },
    body: lines.map(line => JSON.stringify(line)).join("\n") + "\n" });
  assert.equal(res.status, 409); assert.equal((await res.json()).error.code, "room_archived");
  const slot = f.store.createAccountSessionSlot(), current = f.store.accountSessionSlot(slot.token), memberCount = Object.keys(f.store.room("commons").state.members).length;
  assert.throws(() => f.store.shareLinks.join(slot.token, f.links.valid, { displayName: "Late guest", redemptionId: randomUUID(),
    expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding }), { code: "room_archived" });
  assert.throws(() => f.store.invites.redeem(invite.code, { displayName: "Late agent" }), { code: "room_archived" });
  assert.equal(Object.keys(f.store.room("commons").state.members).length, memberCount, "no membership was added");
  for (const path of ["/api/rooms/commons", "/api/rooms/commons/events", "/api/rooms/commons/export"]) {
    res = await fetch(origin + path, { headers: { Authorization: "Bearer " + f.keys.guest } });
    assert.equal(res.status, 200, path);
  }
  res = await fetch(origin + "/api/rooms/commons", { headers: { Authorization: "Bearer " + f.keys.guest } });
  assert.equal((await res.json()).state.room.archivedAt, receipt.event.at);
  assert.equal(auditRecovery(f.store).rooms, 1);
  assert.deepEqual(f.store.rebuildProjection("commons"), f.store.room("commons"));
  // The column is verified against the projection on every open, in both modes; read-only never repairs it.
  f.store.close();
  const raw = new DatabaseSync(join(f.directory, "room.sqlite"));
  raw.exec("PRAGMA foreign_keys=ON"); registerWriter(raw);
  raw.prepare("UPDATE rooms SET archived_at=NULL WHERE id='commons'").run(); raw.close();
  assert.throws(() => new RoomStore(join(f.directory, "room.sqlite")), /Room lifecycle requires operator reconciliation/);
  assert.throws(() => new RoomStore(join(f.directory, "room.sqlite"), { readOnly: true }), /Room lifecycle requires operator reconciliation/);
  const repair = new DatabaseSync(join(f.directory, "room.sqlite"));
  registerWriter(repair);
  repair.prepare("UPDATE rooms SET archived_at=? WHERE id='commons'").run(receipt.event.at); repair.close();
  f.store = new RoomStore(join(f.directory, "room.sqlite"));
  assert.equal(f.store.room("commons").state.room.archivedAt, receipt.event.at);
  const readOnly = new RoomStore(join(f.directory, "room.sqlite"), { readOnly: true });
  try { assert.equal(readOnly.room("commons").state.room.archivedAt, receipt.event.at); } finally { readOnly.close(); }
});

test("store: a seeded history that ends archived stores the column, and one that continues past an archive does not replay", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-lifecycle-seed-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  const archive = event({ type: T.ROOM_ARCHIVED, actorId: owner, roomId: "r", data: {} });
  store.initialize([...seed("r"), archive]);
  assert.equal(store.db.prepare("SELECT archived_at FROM rooms WHERE id='r'").get().archived_at, archive.at);
  assert.throws(() => store.initialize([...seed("s"),
    { ...archive, id: randomUUID(), idempotencyKey: randomUUID(), roomId: "s" },
    event({ type: T.MESSAGE_POSTED, actorId: owner, roomId: "s", data: { messageId: "late", body: "Too late" } })]), /Room is archived/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 1, "the failed seed wrote nothing");
  verifyRoomLifecycle(store);
  assert.equal(auditRecovery(store).schemaVersion, 35);
});

test("migration: genuine v27 data gains rooms.archived_at exactly once, keeps every room, and the migration is idempotent", { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "room-lifecycle-v27-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "v27");
  createRuntimePackage({ repository, commit: v27LifecycleBaseline, destination });
  const createFixture = await frozenRecoveryFixture(repository, destination, v27LifecycleBaseline);
  const f = createFixture(join(root, "room.sqlite"));
  t.after(() => f.store.close());
  const { RoomStore: OldStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const tableSql = db => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rooms'").get().sql;
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 27);
  assert.doesNotMatch(tableSql(f.store.db), /archived_at/, "the baseline predates the column");
  const rooms = f.store.db.prepare("SELECT id,sequence,projection FROM rooms ORDER BY id").all();
  assert.ok(rooms.length >= 2);
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }), /requires schema v35/, "read-only never migrates an older backup");
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 27, "the refused read-only open changed nothing");
  const current = new RoomStore(f.filename, { now: f.now });
  t.after(() => current.close());
  assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, 35);
  assert.match(tableSql(current.db), /archived_at TEXT/);
  assert.deepEqual(current.db.prepare("SELECT id,sequence,projection FROM rooms ORDER BY id").all(), rooms, "no room row changed beyond the new column");
  assert.deepEqual(current.db.prepare("SELECT id FROM rooms WHERE archived_at IS NOT NULL").all(), [], "pre-v28 rooms are not archived");
  const audit = auditRecovery(current);
  assert.equal(audit.schemaVersion, 35);
  const catalog = () => current.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  const schema = catalog(), data = current.db.prepare("SELECT * FROM rooms ORDER BY id").all();
  migrateRoomLifecycleV28(current);
  assert.deepEqual(catalog(), schema, "a second run adds nothing");
  assert.deepEqual(current.db.prepare("SELECT * FROM rooms ORDER BY id").all(), data);
  assert.deepEqual(auditRecovery(current), audit);
  verifyRoomLifecycle(current);
  assert.throws(() => new OldStore(f.filename), /newer than this service/);
  const listed = current.accountRooms(f.owner.token, f.owner.session.sessionBinding).rooms;
  assert.deepEqual(listed.map(room => [room.id, room.kind, room.archived, room.archivedAt]), [["commons", "personal", false, null]]);
  // Migrated rooms archive like new ones and the column follows the event.
  current.command(f.keys.owner, "commons", { id: randomUUID(), type: T.ROOM_ARCHIVED, data: {} });
  const archivedAt = current.room("commons").state.room.archivedAt;
  assert.equal(current.db.prepare("SELECT archived_at FROM rooms WHERE id='commons'").get().archived_at, archivedAt);
  assert.equal(current.accountRooms(f.owner.token, f.owner.session.sessionBinding).rooms[0].archived, true);
  assert.throws(() => current.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "late", body: "Too late" } }), { code: "room_archived" });
  assert.equal(current.room("second").state.room.archivedAt, undefined, "other rooms are untouched");
  const readOnly = new RoomStore(f.filename, { readOnly: true, now: f.now });
  try { assert.equal(readOnly.room("commons").state.room.archivedAt, archivedAt); } finally { readOnly.close(); }
});

test("account rooms: discovery carries kind and archive state; creation is bounded to accounts that administer membership", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const login = accountId => {
    const key = f.store.issueAccountAccessKey(accountId), slot = f.store.createAccountSessionSlot();
    const session = f.store.loginAccountSession(slot.token, key, 0);
    return { token: slot.token, binding: session.sessionBinding };
  };
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "admin", displayName: "Admin", kind: "human", permissions: ["manage_members"] } });
  f.store.createAccount("admin-account"); f.store.bindHumanAccount("commons", "admin", "admin-account");
  const admin = login("admin-account"), guest = login(f.store.accountForMember("commons", "guest").id), ownerKey = login(f.store.accountForMember("commons", "owner").id);
  const request = (overrides = {}) => ({ roomId: "room-a", title: "Alpha", purpose: "Plan the pilot", kind: "organization", displayName: "Admin", ...overrides });
  for (const bad of [null, [], {}, { ...request(), extra: 1 }, request({ roomId: "../x" }), request({ roomId: "x".repeat(65) }), request({ title: "  " }),
    request({ title: "x".repeat(121) }), request({ purpose: "x".repeat(1001) }), request({ displayName: "Badname" }), request({ kind: "team" }), request({ kind: null })]) {
    assert.throws(() => f.store.createAccountRoom(admin.token, admin.binding, bad), { status: 422, code: "invalid_room_request" });
  }
  assert.throws(() => f.store.createAccountRoom(guest.token, guest.binding, request()), { status: 403, code: "room_creation_denied" }, "a conversation-only guest cannot spawn rooms");
  assert.throws(() => f.store.createAccountRoom(ownerKey.token, ownerKey.binding, request()), { status: 403, code: "room_creation_denied" }, "a provisional room-key account is bound to one room");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 1);
  assert.throws(() => f.store.createAccountRoom(admin.token, admin.binding, request({ title: "Two\nlines" })), { status: 422, code: "invalid_room_request" }, "a room name is one line");
  const created = f.store.createAccountRoom(admin.token, admin.binding, request({ title: " Alpha " }));
  assert.deepEqual(created.room, { id: "room-a", title: "Alpha", memberId: "owner", kind: "organization", archived: false, archivedAt: null });
  assert.equal(created.duplicate, false); assert.equal(created.viewer.accountId, "admin-account");
  assert.equal(f.store.createAccountRoom(admin.token, admin.binding, request()).duplicate, true, "the client-chosen id is the idempotency key");
  assert.throws(() => f.store.createAccountRoom(admin.token, admin.binding, request({ title: "Beta" })), { status: 409, code: "room_exists" });
  assert.throws(() => f.store.createAccountRoom(guest.token, guest.binding, request()), { status: 409, code: "room_exists" }, "another account never learns more than the collision");
  const room = f.store.room("room-a").state;
  assert.equal(room.room.kind, "organization"); assert.equal(room.room.ownerId, "owner"); assert.deepEqual(room.members.owner.permissions, [...PERMISSIONS]);
  assert.equal(f.store.accountForMember("room-a", "owner").id, "admin-account");
  const opened = f.store.authenticateAccountSession(admin.token, "room-a", admin.binding);
  assert.equal(opened.member.id, "owner");
  f.store.createAccountRoom(admin.token, admin.binding, request({ roomId: "room-lines", purpose: "Plan the pilot.\nThen run it." }));
  assert.equal(f.store.room("room-lines").state.room.purpose, "Plan the pilot.\nThen run it.", "a purpose may span lines");
  assert.deepEqual(f.store.accountRooms(admin.token, admin.binding).rooms.map(room => [room.id, room.memberId, room.kind, room.archived]),
    [["commons", "admin", "personal", false], ["room-a", "owner", "organization", false], ["room-lines", "owner", "organization", false]]);
  // The creator owns the new room outright: archive it there, leave the old one.
  f.store.command(admin.token, "room-a", { id: randomUUID(), type: T.ROOM_ARCHIVED, data: {} }, admin.binding);
  const member = f.store.room("commons").state.members.admin;
  f.store.command(admin.token, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "admin", expectedMemberRevision: member.revision, permissions: [...member.permissions], active: false } }, admin.binding);
  assert.deepEqual(f.store.accountRooms(admin.token, admin.binding).rooms.map(room => [room.id, room.archived]), [["room-a", true], ["room-lines", false]], "left rooms disappear, archived rooms stay listed");
  assert.throws(() => f.store.authenticateAccountSession(admin.token, "commons", admin.binding), { status: 403 });
  assert.equal(f.store.createAccountRoom(admin.token, admin.binding, request({ roomId: "room-b" })).room.id, "room-b", "owning a room, even an archived one, still qualifies");
  assert.equal(auditRecovery(f.store).rooms, 4);
});

test("account rooms: the membership cap bounds creation", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "admin", displayName: "Admin", kind: "human", permissions: ["manage_members"] } });
  f.store.createAccount("busy-account"); f.store.bindHumanAccount("commons", "admin", "busy-account");
  for (let i = 1; i < 100; i++) { const id = "room-" + String(i).padStart(3, "0"); f.store.initialize(initialRoom(id)); f.store.bindHumanAccount(id, "owner", "busy-account"); }
  const key = f.store.issueAccountAccessKey("busy-account"), slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, key, 0);
  assert.throws(() => f.store.createAccountRoom(slot.token, session.sessionBinding, { roomId: "room-101", title: "One more", purpose: "Over the cap", kind: "personal", displayName: "Admin" }), { status: 409, code: "pilot_limit" });
  assert.equal(f.store.db.prepare("SELECT 1 FROM rooms WHERE id='room-101'").get(), undefined);
});
