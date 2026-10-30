// O-5-FIX (charter ATTENTION-PREP 01), HTTP surface: an agent who creates a
// room through the agent door IS its owner, and GET needs-attention must
// answer them — CRAWL-4 caught this exact shape refused 403 owner_required
// in 9/9 owner cells, and UT-HUMAN re-proved it live on build 90c8d9d2.
// Harness mirrors tests/jev-shadow-http.test.js / agent-access-requests-http.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, fixture };
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

async function agentOwnedRoom(origin, fixture, roomId = "o5-room") {
  const owner = fixture.store.identities.create("o5 owner");
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "O-5 room", purpose: "probe", kind: "personal", displayName: "O-5 room",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  const joiner = fixture.store.identities.create("o5 joiner");
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: joiner.identityId, displayName: "O-5 Joiner",
    requestedPermissions: ["accept_work"], note: null, requestId: "o5-req-1",
  }, joiner.secret);
  assert.equal(reqRes.status, 201);
  return { owner, joiner, roomId };
}

test("agent room-owner reads needs-attention over HTTP and can act on what it shows", async t => {
  const { origin, fixture } = await serve(t);
  const { owner, roomId } = await agentOwnedRoom(origin, fixture);

  const res = await get(origin, `/api/rooms/${roomId}/needs-attention`, owner.secret);
  assert.equal(res.status, 200, "the agent owner is admitted");
  const report = await res.json();
  assert.equal(report.roomId, roomId);
  assert.equal(report.itemCount, 1, "the pending access request is the one item");
  const [item] = report.items;
  assert.equal(item.kind, "access_request");
  assert.deepEqual(item.actions.map(a => a.action), ["approve", "deny"]);

  // The advertised approve action executes over HTTP through the decide
  // route's own gate — the rollup exposed a template, not a new power.
  const approve = item.actions[0];
  assert.equal(approve.method, "POST");
  const decided = await post(origin, approve.path, approve.body, owner.secret);
  assert.equal(decided.status, 200);
  assert.equal((await decided.json()).status, "approved");

  const after = await get(origin, `/api/rooms/${roomId}/needs-attention`, owner.secret);
  assert.equal(after.status, 200);
  assert.equal((await after.json()).itemCount, 0, "a decided request leaves the rollup");
});

test("needs-attention over HTTP still refuses everyone who is not the owner", async t => {
  const { origin, fixture } = await serve(t);
  const { owner, joiner, roomId } = await agentOwnedRoom(origin, fixture);

  const anon = await get(origin, `/api/rooms/${roomId}/needs-attention`);
  assert.equal(anon.status, 401, "no credential, no rollup");

  // The joiner is not a member of the room at all.
  const stranger = await get(origin, `/api/rooms/${roomId}/needs-attention`, joiner.secret);
  assert.equal(stranger.status, 401, "a non-member identity is refused at authentication");

  // The owner of a different room has no standing here.
  const other = fixture.store.identities.create("o5 other owner");
  const otherRoom = await post(origin, "/api/agent-rooms", {
    roomId: "o5-other-room", title: "Other", purpose: "probe", kind: "personal", displayName: "Other",
  }, other.secret);
  assert.equal(otherRoom.status, 201);
  const cross = await get(origin, `/api/rooms/${roomId}/needs-attention`, other.secret);
  assert.equal(cross.status, 401, "another room's owner is refused at authentication");
  assert.ok(owner.secret !== other.secret);
});
