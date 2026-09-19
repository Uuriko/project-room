// RC-2026-09-18-055: capabilities teaches how to delegate.
// GET /api/rooms/{roomId}/capabilities carries next[] — a listed member
// yields a delegate-work step with that member's id filled into the
// assignment body; nobody advertising yields an advertise-capabilities step.
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
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

async function roomWithFriend(origin, fixture) {
  const owner = fixture.store.identities.create("capabilities owner");
  const friend = fixture.store.identities.create("capabilities friend");
  const roomId = "capabilities-room";
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Capabilities", purpose: "probe", kind: "personal", displayName: "Capabilities",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  const requestId = "capabilities-req-1";
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

test("capabilities next[] names advertise-capabilities when nobody advertises", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await roomWithFriend(origin, fixture);
  const res = await get(origin, `/api/rooms/${roomId}/capabilities`, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.members, []);
  assert.deepEqual(json.next.map(n => n.action), ["advertise-capabilities"]);
});

test("capabilities next[] teaches delegate-work for a listed member", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, friendSecret, roomId, memberId } = await roomWithFriend(origin, fixture);
  const advRes = await post(origin, `/api/rooms/${roomId}/commands`, {
    id: "00000000-0000-4000-8000-000000000055",
    type: "capabilities.advertised",
    data: { capabilities: ["web-research", "code-review"] },
  }, friendSecret);
  assert.equal(advRes.status, 201);
  const res = await get(origin, `/api/rooms/${roomId}/capabilities`, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.members.some(m => m.memberId === memberId), "friend is listed");
  assert.deepEqual(json.next.map(n => n.action), ["delegate-work"]);
  const delegate = json.next[0];
  assert.equal(delegate.method, "POST");
  assert.equal(delegate.path, `/api/rooms/${roomId}/collab/assignments`);
  assert.ok(delegate.description.includes(memberId), "delegate-work names the assignee");
});
