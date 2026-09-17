import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("account room discovery uses bounded advancing pages", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.createAccount("many-rooms"); const key = f.store.issueAccountAccessKey("many-rooms");
  const slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, key, 0);
  for (let i = 0; i < 52; i++) {
    const id = "room-" + String(i).padStart(2, "0");
    f.store.initialize(initialRoom(id)); f.store.bindHumanAccount(id, "owner", "many-rooms");
  }
  const first = f.store.accountRooms(slot.token, session.sessionBinding);
  assert.equal(first.rooms.length, 50); assert.equal(first.nextCursor, "room-49");
  const second = f.store.accountRooms(slot.token, session.sessionBinding, { after: first.nextCursor });
  assert.deepEqual(second.rooms.map(r => r.id), ["room-50", "room-51"]); assert.equal(second.nextCursor, null);
  assert.throws(() => f.store.accountRooms(slot.token, session.sessionBinding, { after: "../room" }), { status: 422 });
});

test("account room discovery returns only currently authorized memberships without room content", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "guest"), slot = f.store.createAccountSessionSlot();
  const key = f.store.issueAccountAccessKey(account.id), session = f.store.loginAccountSession(slot.token, key, 0);
  const origin = "http://127.0.0.1:" + server.address().port;
  const headers = { Cookie: "account_session=" + slot.token, "X-Session-Binding": session.sessionBinding };
  let result = await fetch(origin + "/api/account-rooms", { headers }); assert.equal(result.status, 200);
  const body = await result.json(); assert.equal(body.viewer.accountId, account.id);
  assert.deepEqual(body.rooms, [{ id: "commons", title: "Project Room — Disposable Test", memberId: "guest", kind: "personal", archived: false, archivedAt: null }]);
  assert.equal(body.nextCursor, null); assert.equal(JSON.stringify(body).includes("test-request"), false);
  assert.equal(result.headers.get("cache-control"), "no-store");
  result = await fetch(origin + "/api/account-rooms", { headers: { Cookie: headers.Cookie } }); assert.equal(result.status, 422);
  result = await fetch(origin + "/api/account-rooms", { headers: { ...headers, Cookie: "account_session=" + f.keys.producer } }); assert.equal(result.status, 401);
  result = await fetch(origin + "/api/account-rooms?after=commons&after=other", { headers }); assert.equal(result.status, 422);
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "member.access_changed",
    data: { memberId: "guest", expectedMemberRevision: 0, permissions: [], active: false } });
  assert.deepEqual(f.store.accountRooms(slot.token, session.sessionBinding).rooms, []);
  f.store.createAccount("no-room"); const other = f.store.issueAccountAccessKey("no-room");
  const replacement = f.store.loginAccountSession(slot.token, other, 1);
  assert.throws(() => f.store.accountRooms(slot.token, session.sessionBinding), { code: "session_binding_changed" });
  assert.deepEqual(f.store.accountRooms(slot.token, replacement.sessionBinding).rooms, []);
});

test("an account creates a room over HTTP with CSRF, opens it through the same session, and archived rooms stay listed read-only", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "member.added",
    data: { memberId: "admin", displayName: "Admin", kind: "human", permissions: ["manage_members"] } });
  f.store.createAccount("admin-account"); f.store.bindHumanAccount("commons", "admin", "admin-account");
  const key = f.store.issueAccountAccessKey("admin-account"), slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, key, 0);
  const origin = "http://127.0.0.1:" + server.address().port;
  const headers = { Cookie: "account_session=" + slot.token, "X-Session-Binding": session.sessionBinding, Origin: origin, "Content-Type": "application/json" };
  const body = { roomId: "room-http", title: "Over HTTP", purpose: "Created through the account route.", kind: "personal", displayName: "Admin" };
  let result = await fetch(origin + "/api/account-rooms", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(result.status, 422, "the session binding is required before anything else is read");
  result = await fetch(origin + "/api/account-rooms", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Session-Binding": session.sessionBinding }, body: JSON.stringify(body) });
  assert.equal(result.status, 401, "no session cookie");
  result = await fetch(origin + "/api/account-rooms", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(result.status, 403); assert.equal((await result.json()).error.code, "csrf_denied");
  headers["X-CSRF-Token"] = session.csrf;
  result = await fetch(origin + "/api/account-rooms", { method: "POST", headers, body: JSON.stringify({ ...body, kind: "team" }) });
  assert.equal(result.status, 422); assert.equal((await result.json()).error.code, "invalid_room_request");
  assert.equal(f.store.db.prepare("SELECT 1 FROM rooms WHERE id='room-http'").get(), undefined);
  result = await fetch(origin + "/api/account-rooms", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(result.status, 201);
  let created = await result.json();
  assert.deepEqual(created.room, { id: "room-http", title: "Over HTTP", memberId: "owner", kind: "personal", archived: false, archivedAt: null });
  assert.equal(created.duplicate, false); assert.equal(created.viewer.accountId, "admin-account");
  assert.equal(result.headers.get("cache-control"), "no-store");
  result = await fetch(origin + "/api/account-rooms", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(result.status, 200); created = await result.json(); assert.equal(created.duplicate, true);
  result = await fetch(origin + "/api/account-rooms", { method: "POST", headers, body: JSON.stringify({ ...body, title: "Other" }) });
  assert.equal(result.status, 409); assert.equal((await result.json()).error.code, "room_exists");
  // The same account session opens the new room as its owner and can act there.
  const roomHeaders = { Cookie: headers.Cookie, "X-Session-Binding": session.sessionBinding, "X-Project-Room-Auth": "account", Origin: origin, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
  result = await fetch(origin + "/api/rooms/room-http", { headers: roomHeaders }); assert.equal(result.status, 200);
  const snapshot = await result.json(); assert.equal(snapshot.state.room.kind, "personal"); assert.equal(snapshot.state.members.owner.displayName, "Admin");
  result = await fetch(origin + "/api/rooms/room-http/commands", { method: "POST", headers: roomHeaders,
    body: JSON.stringify({ id: crypto.randomUUID(), type: "message.posted", data: { messageId: "hello", body: "First message in a created room." } }) });
  assert.equal(result.status, 201);
  result = await fetch(origin + "/api/rooms/room-http/commands", { method: "POST", headers: roomHeaders, body: JSON.stringify({ id: crypto.randomUUID(), type: "room.archived", data: {} }) });
  assert.equal(result.status, 201);
  result = await fetch(origin + "/api/rooms/room-http/commands", { method: "POST", headers: roomHeaders,
    body: JSON.stringify({ id: crypto.randomUUID(), type: "message.posted", data: { messageId: "late", body: "Too late." } }) });
  assert.equal(result.status, 409); assert.equal((await result.json()).error.code, "room_archived");
  result = await fetch(origin + "/api/account-rooms", { headers: { Cookie: headers.Cookie, "X-Session-Binding": session.sessionBinding } });
  assert.equal(result.status, 200);
  const listed = (await result.json()).rooms.map(room => [room.id, room.memberId, room.kind, room.archived]);
  assert.deepEqual(listed, [["commons", "admin", "personal", false], ["room-http", "owner", "personal", true]]);
  result = await fetch(origin + "/api/rooms/room-http/export", { headers: roomHeaders }); assert.equal(result.status, 200, "export stays available");
});

test("account room discovery is a read: it answers while another writer holds the database and on a read-only store", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-account-rooms-read-")), filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename, { storageFailureThreshold: 1 });
  store.initialize(initialRoom("commons")); store.bindHumanAccount("commons", "owner", "account-owner");
  const key = store.issueAccountAccessKey("account-owner"), slot = store.createAccountSessionSlot(), session = store.loginAccountSession(slot.token, key, 0);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const headers = { Cookie: "account_session=" + slot.token, "X-Session-Binding": session.sessionBinding };
  // Another connection holds the write lock. A write transaction would wait out
  // busy_timeout and fail (counting toward readiness); a WAL read proceeds.
  const reads = t.mock.method(store, "readTransaction");
  const writer = new DatabaseSync(filename); writer.exec("BEGIN IMMEDIATE");
  try {
    const response = await fetch(origin + "/api/account-rooms", { headers });
    assert.equal(response.status, 200);
    assert.ok(reads.mock.callCount() >= 1, "discovery runs in a read transaction, never BEGIN IMMEDIATE");
    assert.deepEqual((await response.json()).rooms.map(room => room.id), ["commons"]);
    assert.deepEqual(store.storageStatus(), { failures: 0, threshold: 1, unavailable: false }, "the read never counts toward readiness");
    assert.equal((await fetch(origin + "/api/ready")).status, 200);
  } finally { writer.exec("ROLLBACK"); writer.close(); }
  // The same read works on a read-only store, as backups are opened.
  const readOnly = new RoomStore(filename, { readOnly: true });
  try {
    assert.deepEqual(readOnly.accountRooms(slot.token, session.sessionBinding).rooms.map(room => room.id), ["commons"]);
  } finally { readOnly.close(); }
});
