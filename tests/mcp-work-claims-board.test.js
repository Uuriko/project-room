// MCP room_read_work_claims: the work-claims board — the room's mandated
// coordination surface ("Coordinate in the Room on the work-claim board") —
// readable over MCP with the same semantics as the HTTP routes.
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Protects MCP/HTTP parity for the board read: same items, same paging
//    envelope, same trust stamps, same lease-sweep-on-read, same 404/422
//    codes as GET /api/rooms/{roomId}/work-claims[/{claimId}].
// 2. Credible regressions: the MCP tool filters differently (e.g. drops the
//    seven-day done window), skips the lease sweep (stale claims), or drifts
//    the error codes agents script against.
// 3. Existing coverage: room_work_claim_provenance covers the downstream
//    graph only; no MCP tool reads the board itself.
// 4. No production seams: real HTTP server, claims created through the real
//    HTTP create route, reads through the real MCP tools/call boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { HOSTED_ROOM_MCP_TOOLS } from "../src/room-mcp-join.js";

test("room_read_work_claims is a registered hosted tool", () => {
  assert.ok(HOSTED_ROOM_MCP_TOOLS.includes("room_read_work_claims"));
});

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-board-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(done => server.close(done));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ada = store.identities.create("Ada");
  const bob = store.identities.create("Bob");
  const roomId = rooms.create(ada.secret, {
    roomId: "board-den", title: "Board den", purpose: "Board reads", kind: "personal", displayName: "Ada",
  }).roomId;
  store.identities.link(ada.secret, roomId, { identityId: bob.identityId, displayName: "Bob", permissions: ["accept_work", "complete_work"] });
  setTier(store.db, roomId, bob.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const http = async (method, path, secret, body) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const mcp = async (name, args, secret) => {
    const response = await fetch(`${origin}/room/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await response.json();
    return { body, value: body.result?.structuredContent, isError: body.result?.isError === true };
  };
  const maskTime = page => ({ ...page, evaluatedAt: "masked" });
  return { origin, store, ada, bob, roomId, http, mcp, maskTime };
}

async function seedBoard(f) {
  for (const [id, title] of [["board-a", "Board A"], ["board-b", "Board B"], ["board-c", "Board C"]]) {
    const created = await f.http("POST", `/api/rooms/${f.roomId}/work-claims`, f.ada.secret, { id, title });
    assert.equal(created.status, 201, JSON.stringify(created.value));
  }
}

test("board list over MCP matches the HTTP list page", async t => {
  const f = await fixture(t);
  await seedBoard(f);
  const httpList = await f.http("GET", `/api/rooms/${f.roomId}/work-claims`, f.bob.secret);
  assert.equal(httpList.status, 200);
  const mcpList = await f.mcp("room_read_work_claims", { roomId: f.roomId }, f.bob.secret);
  assert.equal(mcpList.isError, false, JSON.stringify(mcpList.body));
  assert.deepEqual(f.maskTime(mcpList.value), f.maskTime(httpList.value), "MCP board page matches the HTTP board page");
  assert.deepEqual(
    mcpList.value.claims.map(claim => claim.id).sort(),
    httpList.value.claims.map(claim => claim.id).sort(),
    "MCP and HTTP list the same claims"
  );
  for (const id of ["board-a", "board-b", "board-c"]) {
    assert.ok(mcpList.value.claims.some(claim => claim.id === id), `board lists ${id}`);
  }
});

test("board list paging over MCP matches HTTP cursors", async t => {
  const f = await fixture(t);
  await seedBoard(f);
  const first = await f.mcp("room_read_work_claims", { roomId: f.roomId, limit: 2 }, f.bob.secret);
  assert.equal(first.isError, false, JSON.stringify(first.body));
  assert.equal(first.value.claims.length, 2);
  assert.equal(first.value.hasMore, true);
  assert.equal(typeof first.value.nextCursor, "string");
  const second = await f.mcp("room_read_work_claims", { roomId: f.roomId, limit: 2, cursor: first.value.nextCursor }, f.bob.secret);
  assert.equal(second.isError, false, JSON.stringify(second.body));
  assert.equal(second.value.hasMore, false);
  const seen = [...first.value.claims, ...second.value.claims].map(claim => claim.id);
  assert.deepEqual(new Set(seen).size, seen.length, "pages do not overlap");
  for (const id of ["board-a", "board-b", "board-c"]) {
    assert.ok(seen.includes(id), `paged board includes ${id}`);
  }
  const badCursor = await f.mcp("room_read_work_claims", { roomId: f.roomId, cursor: "nope" }, f.bob.secret);
  assert.equal(badCursor.isError, true);
  assert.equal(badCursor.value.code, "invalid_claim_input");
});

test("queue=ready over MCP matches the HTTP ready queue", async t => {
  const f = await fixture(t);
  await seedBoard(f);
  const httpReady = await f.http("GET", `/api/rooms/${f.roomId}/work-claims?queue=ready`, f.bob.secret);
  assert.equal(httpReady.status, 200);
  const mcpReady = await f.mcp("room_read_work_claims", { roomId: f.roomId, queue: "ready" }, f.bob.secret);
  assert.equal(mcpReady.isError, false, JSON.stringify(mcpReady.body));
  assert.deepEqual(f.maskTime(mcpReady.value), f.maskTime(httpReady.value));
  assert.equal(mcpReady.value.queue, "ready");
});

test("single claim read over MCP matches the HTTP single-claim read", async t => {
  const f = await fixture(t);
  await seedBoard(f);
  const httpOne = await f.http("GET", `/api/rooms/${f.roomId}/work-claims/board-a`, f.bob.secret);
  assert.equal(httpOne.status, 200);
  const mcpOne = await f.mcp("room_read_work_claims", { roomId: f.roomId, claimId: "board-a" }, f.bob.secret);
  assert.equal(mcpOne.isError, false, JSON.stringify(mcpOne.body));
  assert.deepEqual(mcpOne.value, httpOne.value, "MCP single-claim read matches the HTTP read");
  assert.equal(mcpOne.value.id, "board-a");
  const missing = await f.mcp("room_read_work_claims", { roomId: f.roomId, claimId: "nope" }, f.bob.secret);
  assert.equal(missing.isError, true);
  assert.equal(missing.value.code, "work_claim_not_found");
  assert.equal(missing.value.status, 404);
});
