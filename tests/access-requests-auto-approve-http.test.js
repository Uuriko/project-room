// RC-2026-09-29-3603: self-serve admission HTTP surface.
// POST/GET /api/rooms/{roomId}/auto-approve lets a room owner configure the
// standing auto-approve rule; a configured rule approves matching access
// requests inline, in the same filing call. Owner-only; forbidden admin
// permissions are rejected with a teaching 422.
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
  const owner = fixture.store.identities.create("aa owner");
  const roomId = "aa-room";
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Auto approve", purpose: "probe", kind: "personal", displayName: "Auto approve",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  return { ownerSecret: owner.secret, roomId };
}

test("auto-approve: owner sets, reads, and clears the rule", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture);

  const empty = await get(origin, `/api/rooms/${roomId}/auto-approve`, ownerSecret);
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).autoApprove, null);

  const set = await post(origin, `/api/rooms/${roomId}/auto-approve`,
    { permissions: ["accept_work", "complete_work"] }, ownerSecret);
  assert.equal(set.status, 200);
  const saved = await set.json();
  assert.deepEqual(saved.autoApprove.permissions, ["accept_work", "complete_work"]);
  assert.ok(typeof saved.autoApprove.updatedBy === "string");

  const read = await get(origin, `/api/rooms/${roomId}/auto-approve`, ownerSecret);
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).autoApprove.permissions, ["accept_work", "complete_work"]);

  const clear = await post(origin, `/api/rooms/${roomId}/auto-approve`, { permissions: [] }, ownerSecret);
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).autoApprove, null);
});

test("auto-approve: forbidden admin permissions are rejected with 422", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture);

  for (const forbidden of ["manage_members", "decide", "manage_claims"]) {
    const res = await post(origin, `/api/rooms/${roomId}/auto-approve`,
      { permissions: ["accept_work", forbidden] }, ownerSecret);
    assert.equal(res.status, 422, `expected 422 for ${forbidden}`);
    const body = await res.json();
    assert.match(body.error?.message ?? body.message ?? "", /manage|decide|claim/i);
  }
  // The failed writes must not have left a rule behind.
  const read = await get(origin, `/api/rooms/${roomId}/auto-approve`, ownerSecret);
  assert.equal((await read.json()).autoApprove, null);
});

test("auto-approve: non-owner cannot read or write the rule", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture);
  const stranger = fixture.store.identities.create("aa stranger");

  // Not a member at all: the room funnel answers 401.
  const anon = await get(origin, `/api/rooms/${roomId}/auto-approve`, stranger.secret);
  assert.equal(anon.status, 401);

  // A real member holding only accept_work reaches the service-level
  // manage_members check and gets 403.
  const filed = await post(origin, "/api/access-requests", {
    roomId, identityId: stranger.identityId, displayName: "Stranger",
    requestedPermissions: ["accept_work"], note: null, requestId: "aa-member-1",
  });
  assert.equal(filed.status, 201);
  const decide = await post(origin, `/api/rooms/${roomId}/access-requests/aa-member-1/decide`,
    { decision: "approve", permissions: ["accept_work"], note: null }, ownerSecret);
  assert.equal(decide.status, 200);

  const read = await get(origin, `/api/rooms/${roomId}/auto-approve`, stranger.secret);
  assert.equal(read.status, 403);
  const write = await post(origin, `/api/rooms/${roomId}/auto-approve`,
    { permissions: ["accept_work"] }, stranger.secret);
  assert.equal(write.status, 403);
  // Owner's rule is untouched.
  assert.equal((await (await get(origin, `/api/rooms/${roomId}/auto-approve`, ownerSecret)).json()).autoApprove, null);
});

test("auto-approve: matching access request is approved inline over HTTP", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture);
  await post(origin, `/api/rooms/${roomId}/auto-approve`,
    { permissions: ["accept_work", "complete_work"] }, ownerSecret);

  const newcomer = fixture.store.identities.create("aa newcomer");
  const filed = await post(origin, "/api/access-requests", {
    roomId, identityId: newcomer.identityId, displayName: "Newcomer",
    requestedPermissions: ["accept_work"], note: null, requestId: "aa-inline-1",
  });
  assert.equal(filed.status, 201);
  const filedJson = await filed.json();
  assert.equal(filedJson.status, "approved");
  assert.equal(filedJson.decidedBy, "auto-approve");
  assert.ok(filedJson.memberId, "approval links a membership");
  assert.deepEqual(filedJson.grantedPermissions, ["accept_work"]);

  // A request outside the rule still waits for the owner.
  const other = fixture.store.identities.create("aa other");
  const pending = await post(origin, "/api/access-requests", {
    roomId, identityId: other.identityId, displayName: "Other",
    requestedPermissions: ["write_external"], note: null, requestId: "aa-inline-2",
  });
  assert.equal(pending.status, 201);
  assert.equal((await pending.json()).status, "pending");
});

test("auto-approve: wrong method is a 405", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture);
  const res = await fetch(`${origin}/api/rooms/${roomId}/auto-approve`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerSecret}` },
  });
  assert.equal(res.status, 405);
});
