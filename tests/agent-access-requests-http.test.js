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

test("access-requests ignores an Authorization header on the public route (E2)", async t => {
  // QA 2026-09-28: agents attach a bearer everywhere (the packet tells them
  // to send it on every MCP POST). POST /api/access-requests is documented
  // "Public: no credential required" — a header must not turn into a 422.
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { roomId } = await ownerRoom(origin, fixture);
  const friend = fixture.store.identities.create("ar auth-header friend");
  const res = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Header Friend",
    requestedPermissions: [], note: null, requestId: "ar-auth-header-1",
  }, friend.secret);
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.status, "pending");
  assert.deepEqual(json.requestedPermissions, []);
});

// RC-2026-09-28-3410: the access-request gate ports the MCP
// structured-argument shape ({missing, unexpected, invalid}) down to HTTP,
// and its required/optional set aligns with the service: note and requestId
// are optional (the service treats null note as "no note" and mints a
// requestId when omitted). The old gate answered every violation with one
// static "accepted fields" list — a fresh agent could not self-diagnose.
test("access-requests 422 names the missing field (RC-2026-09-28-3410)", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { roomId } = await ownerRoom(origin, fixture);
  const friend = fixture.store.identities.create("ar missing-field friend");
  const res = await post(origin, "/api/access-requests", {
    identityId: friend.identityId, displayName: "Missing",
    requestedPermissions: ["accept_work"], requestId: "ar-missing-1",
  });
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.ok(json.error.message.includes("missing required field: roomId"), "422 names the missing field");
  assert.ok(!json.error.message.includes("accepted fields"), "no static accepted-fields list");
});

test("access-requests 422 names the unexpected field (RC-2026-09-28-3410)", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { roomId } = await ownerRoom(origin, fixture);
  const friend = fixture.store.identities.create("ar unexpected-field friend");
  const res = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Unexpected",
    requestedPermissions: ["accept_work"], requestId: "ar-unexpected-1",
    zzzUnknown: true,
  });
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.ok(json.error.message.includes("unexpected field: zzzUnknown"), "422 names the unexpected field");
});

test("access-requests 422 names the invalid field (RC-2026-09-28-3410)", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { roomId } = await ownerRoom(origin, fixture);
  const friend = fixture.store.identities.create("ar invalid-field friend");
  const res = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Invalid",
    requestedPermissions: "accept_work", requestId: "ar-invalid-1",
  });
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.ok(json.error.message.includes("requestedPermissions: wrong type"), "422 names the invalid field and reason");
});

test("access-requests accepts the 4-required-field shape: note and requestId optional (RC-2026-09-28-3410)", async t => {
  // P1-2 from QA 2026-09-28: the service treats note as optional and mints
  // requestId when omitted; the gate must agree with the service.
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { roomId } = await ownerRoom(origin, fixture);
  const friend = fixture.store.identities.create("ar minimal friend");
  const res = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Minimal",
    requestedPermissions: ["accept_work"],
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.ok(json.requestId, "server mints requestId when omitted");
  assert.equal(json.status, "pending");
});

test("access-requests still accepts the legacy 6- and 7-field shapes (RC-2026-09-28-3410)", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { roomId } = await ownerRoom(origin, fixture);
  for (const [label, body] of [
    ["6-field", { note: "hi", requestId: "ar-legacy-6" }],
    ["7-field", { note: "hi", requestId: "ar-legacy-7", referredBy: "Owner" }],
  ]) {
    const friend = fixture.store.identities.create(`ar legacy ${label} friend`);
    const res = await post(origin, "/api/access-requests", {
      roomId, identityId: friend.identityId, displayName: "Legacy",
      requestedPermissions: ["accept_work"], ...body,
    });
    assert.equal(res.status, 201, `${label} shape still files`);
  }
});
