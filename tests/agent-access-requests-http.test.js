// RC-2026-09-18-056: access-requests teaches how to decide.
// GET /api/rooms/{roomId}/access-requests carries next[] — a pending
// request yields a decide-request step with that request's id filled into
// the decide path; no pending requests yields a watch-requests step.
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

async function ownerRoom(origin, fixture) {
  const owner = fixture.store.identities.create("ar owner");
  const roomId = "ar-room";
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Access requests", purpose: "probe", kind: "personal", displayName: "Access requests",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  return { ownerSecret: owner.secret, roomId };
}

test("access-requests next[] names watch-requests when none are pending", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture);
  const res = await get(origin, `/api/rooms/${roomId}/access-requests`, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.requests, []);
  assert.deepEqual(json.next.map(n => n.action), ["watch-requests"]);
});

test("access-requests next[] teaches decide-request for a pending request", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture);
  const friend = fixture.store.identities.create("ar friend");
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Friend",
    requestedPermissions: ["accept_work"], note: null, requestId: "ar-req-1",
  });
  assert.equal(reqRes.status, 201);
  const res = await get(origin, `/api/rooms/${roomId}/access-requests`, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.requests.length, 1);
  assert.deepEqual(json.next.map(n => n.action), ["decide-request"]);
  const decide = json.next[0];
  assert.equal(decide.method, "POST");
  assert.equal(decide.path, `/api/rooms/${roomId}/access-requests/ar-req-1/decide`);
  assert.ok(decide.description.includes("Friend"), "decide-request names the requester");
  assert.ok(decide.description.includes("approve"), "decide-request shows the decision");
});
