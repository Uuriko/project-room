// RC-2026-09-19-080: a stranger must be able to create their first room.
// An account with zero memberships may always create one room and becomes its
// owner; the membership-administration requirement stands for every further
// room (conversation-only guests and plain members are still denied).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";

const signIn = (f, accountId) => {
  const key = f.store.issueAccountAccessKey(accountId), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, key, 0);
  return { token: slot.token, binding: session.sessionBinding, session, slot };
};
const freshAccount = (f, accountId) => { f.store.createAccount(accountId); return signIn(f, accountId); };
const request = (roomId, overrides = {}) => ({
  roomId, title: "First room", purpose: "Try the product", kind: "personal", displayName: "New user", ...overrides
});
const cleanup = (t, f) => t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });

test("a fresh account with zero memberships creates its first room and becomes owner", t => {
  const f = createAcceptanceFixture(); cleanup(t, f);
  const fresh = freshAccount(f, "fresh-account");
  const created = f.store.createAccountRoom(fresh.token, fresh.binding, request("room-fresh"));
  assert.equal(created.duplicate, false);
  assert.equal(created.room.id, "room-fresh");
  assert.equal(created.room.memberId, "owner", "the creator becomes member owner");
  const state = f.store.room("room-fresh").state;
  assert.equal(state.room.ownerId, "owner");
  assert.deepEqual(state.members.owner.permissions, [...PERMISSIONS], "the owner holds every permission");
  assert.equal(state.members.owner.displayName, "New user");
  assert.equal(f.store.accountForMember("room-fresh", "owner").id, "fresh-account", "the owner member is bound to the account");
});

test("further rooms still follow the membership-administration policy", t => {
  const f = createAcceptanceFixture(); cleanup(t, f);
  // A conversation-only guest in "commons" belongs to one room but administers nothing.
  const guest = signIn(f, f.store.accountForMember("commons", "guest").id);
  assert.throws(() => f.store.createAccountRoom(guest.token, guest.binding, request("room-guest")),
    { status: 403, code: "room_creation_denied" }, "a guest member cannot spawn a room");
  // A member with manage_members (not owner) administers membership.
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "mod", displayName: "Mod", kind: "human", permissions: ["manage_members"] } });
  const mod = freshAccount(f, "mod-account");
  f.store.bindHumanAccount("commons", "mod", "mod-account");
  assert.equal(f.store.createAccountRoom(mod.token, mod.binding, request("room-mod")).room.id, "room-mod");
  // Owning the first room qualifies for a second one.
  const fresh = freshAccount(f, "owner-soon");
  f.store.createAccountRoom(fresh.token, fresh.binding, request("room-one"));
  assert.equal(f.store.createAccountRoom(fresh.token, fresh.binding, request("room-two")).room.id, "room-two",
    "owning a room still qualifies");
});

test("provisional room-key accounts are still denied even when the policy widens", t => {
  const f = createAcceptanceFixture(); cleanup(t, f);
  const ownerKey = signIn(f, f.store.accountForMember("commons", "owner").id);
  assert.throws(() => f.store.createAccountRoom(ownerKey.token, ownerKey.binding, request("room-x")),
    { status: 403, code: "room_creation_denied" }, "a room key stays bound to its one room");
});

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP: a fresh account POSTs its first room (201), the same id replays as 200, a guest is denied (403)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const fresh = freshAccount(f, "http-fresh");
  const headers = {
    "Content-Type": "application/json",
    Cookie: `account_session=${fresh.slot.token}`,
    Origin: origin,
    "X-CSRF-Token": fresh.session.csrf,
    "X-Session-Binding": fresh.binding
  };
  const post = body => fetch(`${origin}/api/account-rooms`, { method: "POST", headers, body: JSON.stringify(body) });
  let res = await post(request("room-http"));
  assert.equal(res.status, 201, "the first room of a fresh account is created");
  const created = await res.json();
  assert.equal(created.duplicate, false);
  assert.equal(created.room.id, "room-http");
  assert.equal(created.room.memberId, "owner");
  res = await post(request("room-http"));
  assert.equal(res.status, 200, "the client-chosen id is the idempotency key over HTTP");
  assert.equal((await res.json()).duplicate, true);
  const guest = signIn(f, f.store.accountForMember("commons", "guest").id);
  const guestHeaders = { ...headers, Cookie: `account_session=${guest.slot.token}`, "X-CSRF-Token": guest.session.csrf, "X-Session-Binding": guest.binding };
  res = await fetch(`${origin}/api/account-rooms`, { method: "POST", headers: guestHeaders, body: JSON.stringify(request("room-http-guest")) });
  assert.equal(res.status, 403, "an existing member without administration is still denied");
  assert.equal((await res.json()).error.code, "room_creation_denied");
});
