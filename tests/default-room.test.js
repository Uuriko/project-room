// RC-2026-09-19-088 — HTTP integration tests for POST
// /api/account/ensure-default-room: first sign-in must never land in an empty
// void. Boots a real server against an acceptance-fixture store over loopback.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, f, options = {}) {
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, data, headers = {}) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...headers },
  body: JSON.stringify(data)
});
const get = (origin, path, creds) => {
  const cookie = typeof creds === "string" ? creds : creds?.cookie;
  const binding = typeof creds === "object" ? creds?.binding : null;
  return fetch(origin + path, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(binding ? { "X-Session-Binding": binding } : {}) }
  });
};
const password = n => `fixture-password-${n}-long-enough`;

// A brand-new account via the real signup route. Signup rotates the session
// slot (QAS-702), so take the fresh token from the response cookie.
async function passwordAccount(t, n) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = `defaultroom-${n}@example.invalid`;
  const slot = f.store.createAccountSessionSlot();
  const res = await post(origin, "/api/auth/password/signup",
    { email, password: password(n), sessionToken: slot.token, sessionRevision: slot.session.sessionRevision });
  assert.equal(res.status, 201);
  const body = await res.json();
  const freshToken = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  assert.ok(freshToken, "signup sets a fresh account_session cookie");
  const slotAfter = f.store.accountSessionSlot(freshToken);
  const creds = { cookie: `account_session=${freshToken}`, csrf: slotAfter.csrf, binding: body.sessionBinding };
  return { f, origin, accountId: body.account.id, creds };
}
const authedPost = (origin, path, creds, data = {}) => post(origin, path, data,
  { Cookie: creds.cookie, "X-CSRF-Token": creds.csrf, "X-Session-Binding": creds.binding });

test("ensure-default-room creates a room for a fresh account", async t => {
  const { origin, creds } = await passwordAccount(t, 1);
  const res = await authedPost(origin, "/api/account/ensure-default-room", creds);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.created, true);
  assert.match(body.room.id, /^personal-[A-Za-z0-9_-]+$/);
});

test("ensure-default-room is idempotent", async t => {
  const { origin, creds } = await passwordAccount(t, 2);
  const first = await (await authedPost(origin, "/api/account/ensure-default-room", creds)).json();
  const res = await authedPost(origin, "/api/account/ensure-default-room", creds);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, false);
  assert.equal(body.room.id, first.room.id);
});

test("ensure-default-room returns the existing room when the account has one", async t => {
  const { origin, creds } = await passwordAccount(t, 3);
  // Create a room through the normal route first.
  const roomId = "room-existing-1";
  const create = await authedPost(origin, "/api/account-rooms", creds,
    { roomId, title: "Existing", purpose: "p", kind: "personal", displayName: "Owner" });
  assert.equal(create.status, 201);
  const res = await authedPost(origin, "/api/account/ensure-default-room", creds);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, false);
  assert.equal(body.room.id, roomId);
});

test("ensure-default-room does not resurrect a room after the account left all rooms", async t => {
  const { f, origin, creds, accountId } = await passwordAccount(t, 4);
  // The account had a room, then left it: ever_had_room is set via trigger.
  const roomId = "room-left-1";
  const create = await authedPost(origin, "/api/account-rooms", creds,
    { roomId, title: "Left", purpose: "p", kind: "personal", displayName: "Owner" });
  assert.equal(create.status, 201);
  assert.equal(f.store.db.prepare("SELECT ever_had_room FROM accounts WHERE id=?").get(accountId).ever_had_room, 1);
  f.store.db.prepare("DELETE FROM member_accounts WHERE account_id=?").run(accountId);
  const res = await authedPost(origin, "/api/account/ensure-default-room", creds);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, false);
  assert.equal(body.room, null);
});

test("ensure-default-room requires authentication", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  // No session binding at all: the route refuses before auth.
  const noBinding = await post(origin, "/api/account/ensure-default-room", {});
  assert.equal(noBinding.status, 422);
  // A binding header but a bogus token: real 401.
  const badToken = await post(origin, "/api/account/ensure-default-room", {},
    { "X-Session-Binding": "0".repeat(64), Cookie: "account_session=invalid" });
  assert.equal(badToken.status, 401);
});

test("the created default room opens for its owner", async t => {
  const { origin, creds } = await passwordAccount(t, 5);
  const body = await (await authedPost(origin, "/api/account/ensure-default-room", creds)).json();
  const rooms = await (await get(origin, "/api/account-rooms", creds)).json();
  assert.ok(rooms.rooms.some(r => r.id === body.room.id));
});
