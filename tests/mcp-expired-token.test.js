// #4493: an expired or stale MCP token must receive the structured 401 the
// /mcp door already produces for bad bearers — never an escaped throw, which
// callers surface as an internal error or a dropped connection. The live
// service answers most stale credentials with that 401 itself; this file
// pins the door's fallthrough for the credential-validation failures that
// THROW out of the service (the shape the expired-token QA specimen hit),
// plus the end-to-end HTTP contract for expired / garbage / valid tokens.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRoomMcp, mcpRpcStatus, mcpAuthHeaders, MCP_AUTH_REQUIRED } from "../server/mcp-http.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { API_KEY_PREFIX } from "../server/agent-api-keys.mjs";

const list = { jsonrpc: "2.0", id: "8", method: "tools/list" };
const url = "https://room.example/mcp";

// The error shape the store's credential checks throw (ServiceError /
// fail() in the server modules): an Error carrying .status and .code.
function credentialError(message = "Unknown agent identity") {
  return Object.assign(new Error(message), { status: 401, code: "unauthenticated" });
}

test("a credential-validation throw from the live service falls through to the structured 401", async () => {
  const roomMcp = async () => { throw credentialError(); };
  const reply = await dispatchRoomMcp(list, { mcpUrl: url, authorization: "Bearer rak_aged-token", roomMcp });
  assert.equal(reply.error?.code, MCP_AUTH_REQUIRED);
  assert.equal(reply.error?.message, "Unknown agent identity");
  assert.equal(reply.error?.data?.retryable, false);
  assert.equal(reply.id, "8");
  assert.equal(mcpRpcStatus(reply), 401);
  assert.match(mcpAuthHeaders(reply)["WWW-Authenticate"] ?? "", /^Bearer /i);
});

test("a thrown 401 without a message still answers the structured 401", async () => {
  const roomMcp = async () => { throw Object.assign(new Error(""), { status: 401 }); };
  const reply = await dispatchRoomMcp(list, { mcpUrl: url, authorization: "Bearer rak_aged-token", roomMcp });
  assert.equal(reply.error?.code, MCP_AUTH_REQUIRED);
  assert.equal(reply.error?.message, "Hosted room tools require a live identity or room token");
  assert.equal(mcpRpcStatus(reply), 401);
});

test("a non-auth failure from the live service is not masked as a 401", async () => {
  const boom = Object.assign(new Error("store unavailable"), { status: 500, code: "internal" });
  const roomMcp = async () => { throw boom; };
  await assert.rejects(
    dispatchRoomMcp(list, { mcpUrl: url, authorization: "Bearer rak_fresh-token", roomMcp }),
    error => error === boom
  );
});

test("a valid token passes through to the live service untouched", async () => {
  const expected = { jsonrpc: "2.0", id: "8", result: { tools: [] } };
  let seen = null;
  const roomMcp = async (_message, options) => { seen = options.authorization; return expected; };
  const reply = await dispatchRoomMcp(list, { mcpUrl: url, authorization: "Bearer rak_fresh-token", roomMcp });
  assert.equal(seen, "Bearer rak_fresh-token");
  assert.equal(reply, expected);
});

// End-to-end through the real HTTP server and the real hosted MCP service.
async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-expired-token-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const owner = store.identities.create("Expired-token owner");
  const created = rooms.create(owner.secret, {
    roomId: "expired-token-room", title: "Expired token room", purpose: "expired token regression",
    kind: "personal", displayName: "Expired-token owner"
  });
  const scopes = [`mcp:room:${created.roomId}`, "rooms:read", "rooms:write", "mcp:inbox", "mcp:wake"];
  const expired = API_KEY_PREFIX + store.agentPlugin.issueApiKey({
    identityId: owner.identityId, scopes, expiresAt: Date.now() - 1000, label: "aged probe"
  }).secret;
  const valid = API_KEY_PREFIX + store.agentPlugin.issueApiKey({
    identityId: owner.identityId, scopes, expiresAt: Date.now() + 60000, label: "fresh probe"
  }).secret;
  return { origin: `http://127.0.0.1:${server.address().port}`, expired, valid };
}

async function postList(origin, credential) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "8", method: "tools/list" })
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("HTTP: an expired room token gets the structured 401, not a dropped connection", async t => {
  const { origin, expired } = await serve(t);
  const reply = await postList(origin, expired);
  assert.equal(reply.status, 401);
  assert.equal(reply.body.error?.code, MCP_AUTH_REQUIRED);
  assert.match(reply.headers.get("www-authenticate") ?? "", /^Bearer /i);
});

test("HTTP: a garbage bearer keeps the structured 401", async t => {
  const { origin } = await serve(t);
  const reply = await postList(origin, "not-a-token");
  assert.equal(reply.status, 401);
  assert.equal(reply.body.error?.code, MCP_AUTH_REQUIRED);
});

test("HTTP: a valid room token passes through", async t => {
  const { origin, valid } = await serve(t);
  const reply = await postList(origin, valid);
  assert.equal(reply.status, 200);
  assert.ok(Array.isArray(reply.body.result?.tools) && reply.body.result.tools.length > 0);
});
