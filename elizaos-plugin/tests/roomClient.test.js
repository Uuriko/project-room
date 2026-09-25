// Unit tests for the ElizaOS plugin's room HTTP client.
//
// Authoring gate: these pin the client's request-formation contract (exact
// method/path/body per action, Bearer behavior) and the canonical error
// envelope -> RoomApiError mapping. The live test proves the real boundary;
// these catch request-shape regressions the server would silently tolerate
// (e.g. a dropped leaseHours field the server defaults instead of
// rejecting). The mock fetch is strict: unknown method+path throws.

import test from "node:test";
import assert from "node:assert/strict";
import { createRoomClient, RoomApiError } from "../src/roomClient.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function strictMockFetch(routes) {
  const captured = [];
  const fetchImpl = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}`;
    const handler = routes.get(key);
    if (!handler) {
      throw new Error(`mock fetch: no route for ${key} — strict mock, unknown calls throw`);
    }
    captured.push({
      method,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: options.headers || {},
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    });
    const { status, json } = await handler(url, options, captured[captured.length - 1]);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `mock-${status}`,
      json: async () => json,
    };
  };
  return { fetchImpl, captured };
}

const ok = json => ({ status: 200, json });
const created = json => ({ status: 201, json });
const err = (status, code, message, hint) => ({
  status,
  json: { error: { code, message }, status: "failed", ...(hint ? { hint } : {}) },
});

const clientFor = (routes, opts = {}) => {
  const { fetchImpl, captured } = strictMockFetch(routes);
  const client = createRoomClient({ baseUrl: "https://room.example", credential: "pri_testsecret", fetchImpl, ...opts });
  return { client, captured };
};

test("redeemInvite posts code+displayName with no Authorization header (credential not yet issued)", async () => {
  const enrollment = { identityId: "ai_x", secret: "pri_new", roomId: "commons", memberId: "ai_x", displayName: "Eliza Bot", permissions: ["accept_work"], next: [] };
  const { client, captured } = clientFor(new Map([["POST /api/agent-invites/redeem", () => created(enrollment)]]), { credential: undefined });
  const res = await client.redeemInvite({ code: "RM-ABC123", displayName: "Eliza Bot" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].path, "/api/agent-invites/redeem");
  assert.deepEqual(captured[0].body, { code: "RM-ABC123", displayName: "Eliza Bot" });
  assert.ok(!("Authorization" in captured[0].headers), "redeem must not send a credential it does not have");
  assert.equal(res.secret, "pri_new");
});

test("redeemInvite rejects missing code/displayName without touching the network", async () => {
  const { client, captured } = clientFor(new Map());
  await assert.rejects(() => client.redeemInvite({ code: "", displayName: "X" }), e => e instanceof RoomApiError && e.code === "invalid_invite_input");
  await assert.rejects(() => client.redeemInvite({ code: "RM-1" }), e => e instanceof RoomApiError && e.code === "invalid_invite_input");
  assert.equal(captured.length, 0);
});

test("authenticated reads send Bearer credential and build the right paths", async () => {
  const routes = new Map([
    ["GET /api/rooms/commons/work-claims", () => ok({ roomId: "commons", claims: [], swept: [] })],
    ["GET /api/rooms/commons/agent-inbox", () => ok({ agentId: "ai_x", directMessages: [] })],
    ["GET /api/rooms/commons/receipts", () => ok({ receipts: [], nextCursor: null })],
    ["GET /api/rooms/commons/events", () => ok({ events: [], next: 1 })],
    ["GET /api/agent-invites/preview", () => ok({ roomId: "commons" })],
  ]);
  const { client, captured } = clientFor(routes);
  await client.listWorkClaims("commons");
  await client.getInbox("commons", { limit: 20 });
  await client.listReceipts("commons", { q: "docs", limit: 5 });
  await client.getEvents("commons", { after: 42, limit: 10 });
  await client.previewInvite("RM-ABC123");
  assert.equal(captured.length, 5);
  for (const call of captured) {
    assert.equal(call.headers.Authorization, "Bearer pri_testsecret", `${call.path} must carry the credential`);
  }
  assert.equal(captured[1].query.get("limit"), "20");
  assert.equal(captured[2].query.get("q"), "docs");
  assert.equal(captured[2].query.get("limit"), "5");
  assert.equal(captured[3].query.get("after"), "42");
  assert.equal(captured[4].query.get("code"), "RM-ABC123");
});

test("claimTask posts note and leaseHours; omits absent fields", async () => {
  const routes = new Map([["POST /api/rooms/commons/work-claims/T-1/claim", () => ok({ id: "T-1", state: "claimed" })]]);
  const { client, captured } = clientFor(routes);
  await client.claimTask("commons", "T-1", { note: "taking this", leaseHours: 12 });
  assert.deepEqual(captured[0].body, { note: "taking this", leaseHours: 12 });
  await client.claimTask("commons", "T-1");
  assert.deepEqual(captured[1].body, {}, "absent optionals must not be sent as undefined/null");
});

test("postMessage sends the commands envelope with uuid idempotency keys", async () => {
  const routes = new Map([["POST /api/rooms/commons/commands", () => created({ event: { eventId: "e1" } })]]);
  const { client, captured } = clientFor(routes);
  await client.postMessage("commons", "status: half done");
  const body = captured[0].body;
  assert.equal(body.type, "message.posted");
  assert.match(body.id, UUID_RE);
  assert.match(body.data.messageId, UUID_RE);
  assert.equal(body.data.body, "status: half done");
  assert.ok(!("channelId" in body.data), "channelId omitted unless given");
});

test("updateClaim done-transition carries delivery evidence; renew cites a progress message", async () => {
  const routes = new Map([
    ["POST /api/rooms/commons/work-claims/T-1/update", () => ok({ id: "T-1", state: "done" })],
    ["POST /api/rooms/commons/work-claims/T-2/renew", () => ok({ id: "T-2", state: "claimed" })],
  ]);
  const { client, captured } = clientFor(routes);
  await client.updateClaim("commons", "T-1", { state: "done", note: "shipped", deliveryMode: "merged", tags: ["docs"] });
  assert.deepEqual(captured[0].body, { state: "done", note: "shipped", deliveryMode: "merged", tags: ["docs"] });
  await client.renewClaim("commons", "T-2", { progressMessageId: "m-9", leaseHours: 24 });
  assert.deepEqual(captured[1].body, { progressMessageId: "m-9", leaseHours: 24 });
});

test("getClaim reads a single work item (strict mock: unknown routes throw)", async () => {
  const routes = new Map([["GET /api/rooms/commons/work-claims/T-9", () => ok({ id: "T-9", state: "in_progress" })]]);
  const { client, captured } = clientFor(routes);
  const claim = await client.getClaim("commons", "T-9");
  assert.equal(claim.id, "T-9");
  assert.equal(captured[0].method, "GET");
  assert.equal(captured[0].path, "/api/rooms/commons/work-claims/T-9");
});

test("releaseClaim posts to the dedicated release route", async () => {
  const routes = new Map([["POST /api/rooms/commons/work-claims/T-1/release", () => ok({ id: "T-1", state: "unclaimed" })]]);
  const { client, captured } = clientFor(routes);
  await client.releaseClaim("commons", "T-1", { note: "not mine after all" });
  assert.deepEqual(captured[0].body, { note: "not mine after all" });
});

test("canonical error envelope maps to RoomApiError with code, message, hint", async () => {
  const routes = new Map([
    ["POST /api/rooms/commons/work-claims/T-1/claim", () => err(409, "work_claim_conflict", "already claimed", "Pick another item.")],
    ["GET /api/rooms/commons/work-claims", () => err(401, "unauthenticated", "no credential")],
  ]);
  const { client } = clientFor(routes);
  const conflict = await client.claimTask("commons", "T-1").catch(e => e);
  assert.ok(conflict instanceof RoomApiError);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "work_claim_conflict");
  assert.equal(conflict.message, "already claimed");
  assert.equal(conflict.hint, "Pick another item.");
  const unauth = await client.listWorkClaims("commons").catch(e => e);
  assert.ok(unauth instanceof RoomApiError && unauth.code === "unauthenticated" && unauth.status === 401);
});

test("non-envelope failures still produce a RoomApiError with an http_NNN code", async () => {
  const routes = new Map([["GET /api/rooms/commons/work-claims", () => ({ status: 502, json: null })]]);
  const { client } = clientFor(routes);
  const error = await client.listWorkClaims("commons").catch(e => e);
  assert.ok(error instanceof RoomApiError);
  assert.equal(error.code, "http_502");
  assert.equal(error.status, 502);
});

test("baseUrl is normalized (trailing slashes stripped)", () => {
  const client = createRoomClient({ baseUrl: "https://room.example///", credential: "x", fetchImpl: async () => { throw new Error("unused"); } });
  assert.equal(client.baseUrl, "https://room.example");
});
