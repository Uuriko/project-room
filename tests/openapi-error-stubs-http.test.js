// PRODUCT-200 C2: the documented body/inbox error stubs pin the live wire
// behavior, so docs/openapi.yaml can't drift from the server. Covers the
// statements with no existing HTTP/store-boundary owner:
//   - 415 json_required on a JSON-body route with a non-JSON Content-Type
//   - 400 invalid_json on a malformed body and on a non-object JSON body
//   - 422 invalid_inbox_selection on agent-inbox with bad query params
//   - 422 invalid_inbox_limit at the store boundary (the MCP-tool entry shape)
// 405-Allow and 503 room_unavailable doc statements are already pinned by
// tests/inbox-collab-http.test.js:694, tests/low-batch-1529.test.js:42 and
// tests/job-heartbeat.test.js:280 — not duplicated here.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, fixture) {
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret, contentType = "application/json") =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body,
  });
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

// Room with an owner and one approved agent friend; returns their secrets
// and the room id. Mirrors tests/agent-inbox.test.js.
async function roomWithFriend(origin, fixture) {
  const owner = fixture.store.identities.create("stubs owner");
  const friend = fixture.store.identities.create("stubs friend");
  const roomId = "stubs-room";
  const roomRes = await post(origin, "/api/agent-rooms", JSON.stringify({
    roomId, title: "Stubs", purpose: "probe", kind: "personal", displayName: "Stubs",
  }), owner.secret);
  assert.equal(roomRes.status, 201);
  const requestId = "stubs-req-1";
  const reqRes = await post(origin, "/api/access-requests", JSON.stringify({
    roomId, identityId: friend.identityId, displayName: "Friend",
    requestedPermissions: ["accept_work"], note: null, requestId,
  }), null);
  assert.equal(reqRes.status, 201);
  const decideRes = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`, JSON.stringify({
    decision: "approve", permissions: ["accept_work"], note: null,
  }), owner.secret);
  assert.equal(decideRes.status, 200);
  return { friendSecret: friend.secret, roomId };
}

async function errorOf(res) {
  assert.equal(res.headers.get("content-type")?.includes("application/json"), true);
  return (await res.json()).error;
}

test("415 json_required: a JSON-body route with a non-JSON Content-Type", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friendSecret, roomId } = await roomWithFriend(origin, fixture);
  const res = await post(origin, `/api/rooms/${roomId}/commands`, "{ok:true}", friendSecret, "text/plain");
  assert.equal(res.status, 415);
  assert.equal((await errorOf(res)).code, "json_required");
});

test("400 invalid_json: malformed and non-object JSON bodies", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friendSecret, roomId } = await roomWithFriend(origin, fixture);
  for (const [name, body] of [
    ["malformed", "{not json"],
    ["array", "[1,2]"],
    ["scalar", "42"],
  ]) {
    const res = await post(origin, `/api/rooms/${roomId}/commands`, body, friendSecret);
    assert.equal(res.status, 400, name);
    assert.equal((await errorOf(res)).code, "invalid_json", name);
  }
});

test("body guards are input-specific: a valid JSON object reaches the command layer", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friendSecret, roomId } = await roomWithFriend(origin, fixture);
  const res = await post(origin, `/api/rooms/${roomId}/commands`, JSON.stringify({}), friendSecret);
  assert.notEqual(res.status, 415);
  assert.notEqual((await errorOf(res)).code, "invalid_json");
});

test("422 invalid_inbox_selection: bad query params on GET agent-inbox", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friendSecret, roomId } = await roomWithFriend(origin, fixture);
  const path = `/api/rooms/${roomId}/agent-inbox`;
  for (const [name, query] of [
    ["unknown key", "?bogus=1"],
    ["non-integer limit", "?limit=abc"],
    ["zero limit", "?limit=0"],
    ["limit over 200", "?limit=201"],
    ["repeated limit", "?limit=5&limit=5"],
  ]) {
    const res = await get(origin, path + query, friendSecret);
    assert.equal(res.status, 422, name);
    assert.equal((await errorOf(res)).code, "invalid_inbox_selection", name);
  }
  const ok = await get(origin, path + "?limit=10", friendSecret);
  assert.equal(ok.status, 200, "a valid limit still reads the inbox");
});

test("422 invalid_inbox_limit: the store guard fires for MCP-shaped calls that bypass query validation", async t => {
  // The MCP room_read_inbox tool passes its limit straight to the store
  // (server/mcp-full-profile.mjs), skipping the route's query validation,
  // so the store is the owner boundary for this error.
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friendSecret, roomId } = await roomWithFriend(origin, fixture);
  for (const limit of [0, -1, 201, 1.5, Number.NaN]) {
    assert.throws(
      () => fixture.store.agentInbox(friendSecret, roomId, { limit }),
      error => error.status === 422 && error.code === "invalid_inbox_limit",
      `limit ${String(limit)}`,
    );
  }
  assert.doesNotThrow(() => fixture.store.agentInbox(friendSecret, roomId, { limit: 50 }),
    "an in-range limit passes the guard");
});
