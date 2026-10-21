// ChatGPT app profile: /mcp/chatgpt tools, widgets, OAuth discovery and
// dynamic client registration. No network beyond the local test server.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { dispatchRoomMcp } from "../server/mcp-http.mjs";
import {
  CHATGPT_APP_TOOL_NAMES, WIDGETS, WIDGET_MIME, chatgptAppTools, mapChatgptToolCall,
  readChatgptWidget, handleChatgptAppRpc, protectedResourceMetadata,
} from "../server/chatgpt-app.mjs";

const rpc = (method, params = {}) => ({ jsonrpc: "2.0", id: "1", method, params });

test("five tools, each linked to a registered widget and an OAuth scheme", () => {
  assert.deepEqual(CHATGPT_APP_TOOL_NAMES, ["room_open", "room_needs_you", "room_post", "room_who_is_working", "room_approve"]);
  const uris = new Set(Object.values(WIDGETS));
  for (const tool of chatgptAppTools()) {
    assert.ok(uris.has(tool._meta.ui.resourceUri), tool.name);
    assert.equal(tool._meta["openai/outputTemplate"], tool._meta.ui.resourceUri);
    assert.equal(tool.securitySchemes[0].type, "oauth2");
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(tool.annotations.destructiveHint, tool.name === "room_approve", tool.name);
    if (!tool.annotations.readOnlyHint) assert.equal(tool.annotations.idempotentHint, false, tool.name);
    assert.ok(tool.description.startsWith("Use this"), tool.name);
    assert.equal("map" in tool, false);
  }
});

test("widgets are MCP Apps HTML with a CSP and no remote scripts", () => {
  for (const uri of Object.values(WIDGETS)) {
    const { contents: [entry] } = readChatgptWidget(uri);
    assert.equal(entry.mimeType, WIDGET_MIME);
    assert.deepEqual(entry._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.ok(entry._meta["openai/widgetDescription"]);
    assert.doesNotMatch(entry.text, /<script[^>]+src=/);
    assert.match(entry.text, /ui\/notifications\/tool-result/);
  }
  assert.equal(readChatgptWidget("ui://nope"), null);
});

test("calls map onto the existing room profile tools", () => {
  assert.deepEqual(mapChatgptToolCall("room_open", { title: "Launch", purpose: "Ship it" }), { name: "room_create", arguments: { title: "Launch", purpose: "Ship it" } });
  assert.deepEqual(mapChatgptToolCall("room_open", { inviteCode: "abc" }), { name: "room_join", arguments: { inviteCode: "abc" } });
  assert.equal(mapChatgptToolCall("room_open", { title: "only title" }), null);
  assert.equal(mapChatgptToolCall("room_open", { inviteCode: "a", linkToken: "b" }), null);
  assert.deepEqual(mapChatgptToolCall("room_post", { roomId: "r", body: "hi" }), { name: "room_post_message", arguments: { roomId: "r", body: "hi" } });
  assert.equal(mapChatgptToolCall("room_post", { roomId: "r" }), null);
  assert.equal(mapChatgptToolCall("room_post", { roomId: "r", body: "x", extra: 1 }), null);
  assert.deepEqual(mapChatgptToolCall("room_approve", { roomId: "r", requestId: "q", decision: "approve" }).name, "room_decide_access_request");
  assert.equal(mapChatgptToolCall("room_needs_you", {}).name, "room_needs_me");
  assert.equal(mapChatgptToolCall("room_who_is_working", { roomId: "r" }).name, "get_room_context");
});

test("tools/list and resources work without sign-in; tools/call asks for OAuth", async () => {
  const opts = { origin: "https://room.example", delegate: async () => assert.fail("must not delegate") };
  assert.equal((await handleChatgptAppRpc(rpc("tools/list"), opts)).result.tools.length, 5);
  assert.equal((await handleChatgptAppRpc(rpc("resources/list"), opts)).result.resources.length, 3);
  const init = await handleChatgptAppRpc(rpc("initialize", { protocolVersion: "2025-06-18" }), opts);
  assert.ok(init.result.capabilities.resources);
  const denied = await handleChatgptAppRpc(rpc("tools/call", { name: "room_needs_you", arguments: {} }), opts);
  assert.equal(denied.error.code, -32001);
  assert.match(denied.error.data.wwwAuthenticate, /resource_metadata="https:\/\/room\.example\/\.well-known\/oauth-protected-resource"/);
});

test("an unresolved OAuth token is refused and a resolved one delegates with widget meta", async () => {
  const seen = [];
  const delegate = async (message, extra) => { seen.push({ message, extra }); return { jsonrpc: "2.0", id: message.id, result: { content: [], structuredContent: { items: [] } } }; };
  const refused = await handleChatgptAppRpc(rpc("tools/call", { name: "room_needs_you", arguments: {} }), { authorization: "Bearer oauth-token", delegate, resolveBearer: async () => null });
  assert.equal(refused.error.code, -32001);
  assert.equal(seen.length, 0);
  const reply = await handleChatgptAppRpc(rpc("tools/call", { name: "room_needs_you", arguments: {} }), { authorization: "Bearer oauth-token", delegate, resolveBearer: async () => "Bearer mapped" });
  assert.equal(seen[0].message.params.name, "room_needs_me");
  assert.equal(seen[0].extra.authorization, "Bearer mapped");
  assert.equal(reply.result._meta.ui.resourceUri, WIDGETS.needs);
});

test("dispatchRoomMcp routes /mcp/chatgpt and leaves /mcp alone", async () => {
  const chat = await dispatchRoomMcp(rpc("tools/list"), { mcpUrl: "https://room.example/mcp/chatgpt", pathname: "/mcp/chatgpt" });
  assert.deepEqual(chat.result.tools.map(t => t.name), CHATGPT_APP_TOOL_NAMES);
  const plain = await dispatchRoomMcp(rpc("tools/list"), { mcpUrl: "https://room.example/mcp", pathname: "/mcp" });
  assert.notDeepEqual(plain.result?.tools?.map(t => t.name), CHATGPT_APP_TOOL_NAMES);
  // Identity secrets pass straight through to the room profile.
  let passed;
  await dispatchRoomMcp(rpc("tools/call", { name: "room_post", arguments: { roomId: "r", body: "hi" } }), {
    mcpUrl: "https://room.example/mcp/chatgpt", pathname: "/mcp/chatgpt", authorization: "Bearer pri_fixture",
    roomMcp: async (message, extra) => { passed = { message, extra }; return { jsonrpc: "2.0", id: message.id, result: { content: [] } }; },
  });
  assert.equal(passed.message.params.name, "room_post_message");
  assert.equal(passed.extra.authorization, "Bearer pri_fixture");
});

test("HTTP: protected resource metadata, registration endpoint and 401 header", async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); fixture.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const as = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.registration_endpoint, as.issuer + "/oauth/register");
  const pr = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp/chatgpt`)).json();
  assert.deepEqual(pr.authorization_servers, [as.issuer]);
  assert.deepEqual(pr, protectedResourceMetadata(as.issuer));

  const reg = await fetch(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] }) });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  assert.match(client.client_id, /^dcr_[0-9a-f]{32}$/);
  assert.equal(client.token_endpoint_auth_method, "none");
  const bad = await fetch(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(bad.status, 400);
  const secretClient = await fetch(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" }) });
  assert.equal(secretClient.status, 400);

  const call = await fetch(`${origin}/mcp/chatgpt`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(rpc("tools/call", { name: "room_needs_you", arguments: {} })) });
  assert.equal(call.status, 401);
  assert.match(call.headers.get("www-authenticate"), /resource_metadata=/);
});
