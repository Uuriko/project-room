// Edge-served anonymous MCP (SPEED-PLAN rank 1): the Worker answers the
// store-free anonymous MCP surface without dispatching the Durable
// Object. Pins:
//  1. Byte parity: for every pure anonymous message, the edge response
//     body/status equals what dispatchRoomMcp (the DO dispatch) produces
//     for the same message — the catalog code is the same code.
//  2. Fall-through: presented credentials, store-backed anonymous calls
//     (public-work, identity-mint) and every non-MCP path return null,
//     so the original request reaches the DO untouched.
//  3. The XW7 carve-out: /receipts/* and /r/*/proof are never answered
//     here — no receipt content is served or cached on this path.
import test from "node:test";
import assert from "node:assert/strict";
import { edgeAnonymousMcpResponse, edgeMcpApplies } from "../cloudflare/edge-mcp.mjs";
import { dispatchRoomMcp, mcpRpcStatus, roomMcpFetchResponse } from "../server/mcp-http.mjs";
import { roomMcpUrlForHost } from "../src/room-mcp-join.js";

const ORIGIN = "https://room.trydemigod.com";
const post = (body, headers = {}, path = "/mcp") => new Request(`${ORIGIN}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const rpc = (method, params, id = "edge-1") => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

async function edge(request) {
  const url = new URL(request.url);
  return edgeAnonymousMcpResponse(request, url);
}

async function assertParity(t, message, headers = {}) {
  const request = post(message, headers);
  const response = await edge(request.clone());
  assert.ok(response, `edge must answer ${message.method}`);
  const expected = await dispatchRoomMcp(message, { mcpUrl: roomMcpUrlForHost(new URL(request.url)) });
  assert.equal(response.status, mcpRpcStatus(expected), `${message.method}: status parity`);
  // Error envelopes carry a random per-call operationId (agentErrorBody)
  // on BOTH paths — two DO answers to the same bad request differ there
  // too — so parity is asserted on the body with that one field masked.
  const mask = text => text.replace(/"operationId":"[^"]+"/g, '"operationId":"op_MASK"');
  assert.equal(mask(await response.text()), mask(JSON.stringify(expected)), `${message.method}: body bytes parity`);
  return response;
}

test("anonymous tools/list, initialize and ping are answered at the edge, byte-identical to dispatch", async t => {
  await assertParity(t, rpc("tools/list"));
  await assertParity(t, rpc("initialize", {
    protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "edge-test", version: "1" },
  }));
  await assertParity(t, rpc("ping"));
  await assertParity(t, rpc("tools/list", { cursor: "nope" })); // the no-cursor error reply is pure too
  await assertParity(t, rpc("server/discover"));
  await assertParity(t, rpc("no/such-method"));
});

test("the four join tools/call are answered at the edge, byte-identical to dispatch", async t => {
  for (const name of ["room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet"]) {
    await assertParity(t, rpc("tools/call", { name, arguments: {} }));
  }
  // Unknown and hosted tool names on the anonymous surface are pure
  // error replies in dispatch (unknown_tool / auth_required) — parity.
  await assertParity(t, rpc("tools/call", { name: "room_join_packt", arguments: {} }));
  await assertParity(t, rpc("tools/call", { name: "room_post_message", arguments: {} }));
});

test("malformed bodies fall through to the DO boundary; in-protocol errors keep parity", async t => {
  // Unparseable and non-object bodies are NOT edge-served: the DO
  // boundary owns malformed-request handling and its failure
  // containment (503 room_unavailable when the object is down, pinned
  // by tests/job-heartbeat.test.js "Room request boundary").
  assert.equal(await edge(post("{not json")), null);
  assert.equal(await edge(post("")), null);
  assert.equal(await edge(post(["not", "an", "object"])), null);
  await assertParity(t, { jsonrpc: "1.0", id: "x", method: "tools/list" });
  // Notifications (no id) are a 202 with no body, as on the Node door.
  const note = await edge(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(note.status, 202);
  assert.equal(await note.text(), "");
});

test("fall-through: presented credentials and store-backed anonymous calls stay with the DO", async t => {
  assert.equal(await edge(post(rpc("tools/list"), { authorization: "Bearer pri_deadbeef" })), null,
    "any presented credential routes to the DO exactly as before");
  assert.equal(await edge(post(rpc("tools/call", { name: "public_work_recommend", arguments: {} }))), null,
    "public-work calls are store-backed");
  assert.equal(await edge(post(rpc("tools/call", { name: "public_work_claim", arguments: {} }))), null);
  assert.equal(await edge(post(rpc("tools/call", { name: "room_identity_mint", arguments: {} }))), null,
    "identity mint is store-backed");
  // An empty Bearer is no credential (dispatchRoomMcp's own test): the
  // pure surface still answers.
  const emptyBearer = await edge(post(rpc("tools/list"), { authorization: "Bearer " }));
  assert.ok(emptyBearer, "empty Bearer counts as anonymous");
  assert.equal(emptyBearer.status, 200);
});

test("GET/HEAD/OPTIONS on MCP paths return the join document at the edge", async t => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const request = new Request(`${ORIGIN}/mcp`, { method });
    const response = await edge(request);
    const expected = roomMcpFetchResponse(new Request(`${ORIGIN}/mcp`, { method }));
    assert.equal(response.status, expected.status, `${method} status`);
    assert.equal(await response.text(), await expected.text(), `${method} body`);
  }
  for (const path of ["/mcp/", "/room/mcp", "/mcp/claude", "/room/mcp/codex/"]) {
    assert.equal(edgeMcpApplies(new URL(`${ORIGIN}${path}`)), true, `${path} is an MCP path`);
    const response = await edge(post(rpc("tools/list"), {}, path));
    assert.equal(response.status, 200, `${path} tools/list answered at the edge`);
  }
});

test("XW7 carve-out: receipts and proof paths are never answered at the edge", async t => {
  for (const path of ["/receipts/abc", "/receipts", "/r/some-room/proof", "/api/rooms/commons", "/api/health", "/mcpfoo"]) {
    assert.equal(edgeMcpApplies(new URL(`${ORIGIN}${path}`)), false, `${path} is not an MCP path`);
    assert.equal(await edge(post(rpc("tools/list"), {}, path)), null, `${path} falls through`);
    assert.equal(await edge(new Request(`${ORIGIN}${path}`, { method: "GET" })), null, `${path} GET falls through`);
  }
});

test("edge answers carry the Node door's POST header shape", async t => {
  const response = await edge(post(rpc("tools/list")));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("x-robots-tag"), "all");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(Number(response.headers.get("content-length")) > 0);
});
