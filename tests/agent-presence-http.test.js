// RC-2026-09-18-054: presence teaches how to DM a member.
// GET /api/rooms/{roomId}/presence carries next[] — a listed member yields
// a dm-member step with that member's id filled into the message.posted
// command; nobody online yields a watch-presence step.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null, signal = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
  ...(signal ? { signal } : {}),
});

async function roomWithFriend(origin, fixture) {
  const owner = fixture.store.identities.create("presence owner");
  const friend = fixture.store.identities.create("presence friend");
  const roomId = "presence-room";
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Presence", purpose: "probe", kind: "personal", displayName: "Presence",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  const requestId = "presence-req-1";
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Friend",
    requestedPermissions: ["accept_work"], note: null, requestId,
  });
  assert.equal(reqRes.status, 201);
  const decideRes = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null,
  }, owner.secret);
  assert.equal(decideRes.status, 200);
  const memberId = (await decideRes.json()).memberId;
  assert.ok(memberId);
  return { ownerSecret: owner.secret, friendSecret: friend.secret, roomId, memberId };
}

test("presence next[] names watch-presence when nobody is online", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await roomWithFriend(origin, fixture);
  const res = await get(origin, `/api/rooms/${roomId}/presence`, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.members, []);
  assert.deepEqual(json.next.map(n => n.action), ["watch-presence"]);
});

test("presence next[] teaches dm-member for a listed member", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, friendSecret, roomId, memberId } = await roomWithFriend(origin, fixture);
  // Hold the friend's event stream open so presence lists them as online.
  const controller = new AbortController();
  const streamPromise = get(origin, `/api/rooms/${roomId}/stream`, friendSecret, controller.signal)
    .catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 300));
  try {
    const res = await get(origin, `/api/rooms/${roomId}/presence`, ownerSecret);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.members.some(m => m.memberId === memberId), "friend is listed online");
    assert.deepEqual(json.next.map(n => n.action), ["dm-member"]);
    const dm = json.next[0];
    assert.equal(dm.method, "POST");
    assert.equal(dm.path, `/api/rooms/${roomId}/commands`);
    assert.ok(dm.description.includes(memberId), "dm-member names the member to DM");
  } finally {
    controller.abort();
    await streamPromise;
  }
});
