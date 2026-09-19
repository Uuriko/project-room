// RC-2026-09-18-057: work-sessions teaches how to join.
// GET /api/rooms/{roomId}/work-sessions carries next[] — open sessions
// yield a claim-session step with the workItemId filled into the atomic
// claim body; no open sessions yields a start-session step.
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
  const owner = fixture.store.identities.create("ws owner");
  const roomId = "ws-room";
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Work sessions", purpose: "probe", kind: "personal", displayName: "Work sessions",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  return { ownerSecret: owner.secret, roomId };
}

test("work-sessions next[] names start-session when none are open", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture);
  const res = await get(origin, `/api/rooms/${roomId}/work-sessions`, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.sessions, []);
  assert.deepEqual(json.next.map(n => n.action), ["start-session"]);
});

test("work-sessions next[] teaches claim-session for an open session", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture);
  const friend = fixture.store.identities.create("ws friend");
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Friend",
    requestedPermissions: ["accept_work"], note: null, requestId: "ws-req-1",
  });
  assert.equal(reqRes.status, 201);
  const decideRes = await post(origin, `/api/rooms/${roomId}/access-requests/ws-req-1/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null,
  }, ownerSecret);
  assert.equal(decideRes.status, 200);
  const memberId = (await decideRes.json()).memberId;
  const propRes = await post(origin, `/api/rooms/${roomId}/commands`, {
    id: "00000000-0000-4000-8000-000000000057",
    type: "work.proposed",
    data: {
      workItemId: "ws-item-1", title: "Draft the agenda",
      definitionOfDone: "Named next step",
      accountableMemberId: memberId, mode: "read",
    },
  }, ownerSecret);
  assert.equal(propRes.status, 201);
  const res = await get(origin, `/api/rooms/${roomId}/work-sessions`, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.sessions.some(s => s.workItemId === "ws-item-1"), "session is listed");
  assert.deepEqual(json.next.map(n => n.action), ["claim-session"]);
  const claim = json.next[0];
  assert.equal(claim.method, "POST");
  assert.equal(claim.path, `/api/rooms/${roomId}/work-sessions`);
  assert.ok(claim.description.includes("ws-item-1"), "claim-session names the work item");
  assert.ok(claim.description.includes("processing"), "claim-session shows the atomic claim");
});
