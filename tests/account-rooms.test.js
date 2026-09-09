import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
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
  assert.deepEqual(body.rooms, [{ id: "commons", title: "Project Room — Disposable Test", memberId: "guest" }]);
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
