import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ROUTES } from "../server/routes/table.mjs";
import { matchRoute } from "../server/routes/dispatch.mjs";

// #3406 parity: GET /api/rooms/{roomId}/access-requests was implemented
// twice — the route-table row `list-member-access-requests`
// (server/routes/member-permissions.mjs) and a legacy branch in
// server/http.mjs (`route === "access-requests" && req.method === "GET"`).
// http.mjs calls dispatchRoute before the legacy chain and a matched row
// never falls through (the handler runs, or auth rejects), so the table
// row has always been the served behaviour. These tests pin that served
// behaviour end to end over real HTTP; the last test pins the legacy
// branch's absence so the route cannot be double-served again.
//
// Deliberate differences from the deleted legacy branch, kept on purpose
// (the table row's wording is the live contract agents already see):
// - the decide-request hint ends "Send your current room credential."
//   (legacy: "Send your identity secret as the Bearer token.")
// - the empty-queue hint is "No pending access requests."
//   (legacy: "No pending join requests. New requests from agents asking
//   to join appear here.")
// - the decide path encodeURIComponent-encodes roomId and requestId
//   (legacy interpolated both raw; server-minted ids read identically)
// - a scoped API key without rooms:read is refused 403
//   insufficient_scope with "API key lacks rooms:read" (the legacy funnel
//   said "API key lacks the rooms:read scope"); status and code match.
async function setup(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const owner = store.issueAccessKey("commons", "owner");
  const member = store.identities.create("Ordinary Member");
  store.identities.link(owner, "commons", { identityId: member.identityId, permissions: ["accept_work"] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const list = async (token, query = "") => {
    const response = await fetch(`${origin}/api/rooms/commons/access-requests${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    return { status: response.status, body: await response.json() };
  };
  return { store, requests, owner, member, list };
}

test("anonymous callers are refused before the queue is read", async t => {
  const f = await setup(t);
  const refused = await f.list(null);
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error.code, "unauthenticated");
});

test("a member without membership administration cannot list the queue", async t => {
  const f = await setup(t);
  const refused = await f.list(f.member.secret);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "access_denied");
});

test("an empty queue answers the table row's watch-requests hint", async t => {
  const f = await setup(t);
  const empty = await f.list(f.owner);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, {
    roomId: "commons",
    requests: [],
    next: [{ action: "watch-requests", description: "No pending access requests." }]
  });
});

test("a pending request answers the table row's decide-request hint", async t => {
  const f = await setup(t);
  const joiner = f.store.identities.create("Parity Joiner");
  f.requests.request("commons", {
    identityId: joiner.identityId,
    displayName: "Parity Joiner",
    requestedPermissions: ["accept_work"],
    requestId: "parity_join"
  }, joiner.secret);
  const queue = await f.list(f.owner);
  assert.equal(queue.status, 200);
  assert.equal(queue.body.roomId, "commons");
  assert.equal(queue.body.requests.length, 1);
  assert.equal(queue.body.requests[0].requestId, "parity_join");
  assert.equal(queue.body.requests[0].status, "pending");
  assert.deepEqual(queue.body.next, [{
    action: "decide-request",
    method: "POST",
    path: "/api/rooms/commons/access-requests/parity_join/decide",
    description: "Decide Parity Joiner's request: send { decision: \"approve\", permissions: [\"accept_work\"], note: null }. Use \"deny\" to refuse. Send your current room credential."
  }]);
});

test("the status filter defaults to pending and validates its value", async t => {
  const f = await setup(t);
  const joiner = f.store.identities.create("Status Joiner");
  f.requests.request("commons", {
    identityId: joiner.identityId,
    displayName: "Status Joiner",
    requestedPermissions: ["accept_work"],
    requestId: "parity_status"
  }, joiner.secret);
  f.requests.decide(f.owner, "commons", "parity_status", { decision: "deny" });
  const pending = await f.list(f.owner);
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.body.requests, []);
  const denied = await f.list(f.owner, "?status=denied");
  assert.equal(denied.status, 200);
  assert.equal(denied.body.requests.length, 1);
  assert.equal(denied.body.requests[0].requestId, "parity_status");
  const invalid = await f.list(f.owner, "?status=bogus");
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, "invalid_request");
});

test("the route table owns the route and the legacy branch is gone", () => {
  const matched = matchRoute(ROUTES, "GET", "/api/rooms/commons/access-requests");
  assert.equal(matched.row?.id, "list-member-access-requests");
  const http = readFileSync(new URL("../server/http.mjs", import.meta.url), "utf8");
  assert.ok(!http.includes('route === "access-requests"'),
    "server/http.mjs must not carry a second access-requests implementation");
});
