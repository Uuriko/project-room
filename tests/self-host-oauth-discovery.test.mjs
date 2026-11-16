// A self-hosted Room that sets ROOM_MCP_OAUTH_CLIENTS must be discoverable by
// an MCP host from a bare 401, with no hand-written host config. Without it,
// native OAuth stays off (the documented default).
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { defaultServerArgs } from "../server/boot-options.mjs";

const origin = "https://room.example";
const client = { clientId: "self-host-test", name: "Host", redirectUris: ["https://client.example/callback"] };

async function boot(t, env) {
  const store = new RoomStore(":memory:");
  const server = createRoomServer(defaultServerArgs({ store, origin, env }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const port = server.address().port;
  return (path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { Host: "room.example", ...headers } }, res => {
      const chunks = []; res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end(body);
  });
}
const initialize = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "host", version: "1" } } }) };

test("with ROOM_MCP_OAUTH_CLIENTS the bare 401 names the protected-resource metadata, which names the authorization server and its registration endpoint", async t => {
  const get = await boot(t, { ROOM_MCP_OAUTH_CLIENTS: JSON.stringify([client]) });
  const challenge = await get("/mcp", initialize);
  assert.equal(challenge.status, 401);
  assert.equal(challenge.headers["www-authenticate"].match(/resource_metadata="([^"]+)"/)?.[1], `${origin}/.well-known/oauth-protected-resource/mcp`);
  const prm = await get("/.well-known/oauth-protected-resource/mcp");
  assert.equal(prm.status, 200);
  assert.deepEqual({ resource: JSON.parse(prm.text).resource, authorization_servers: JSON.parse(prm.text).authorization_servers }, { resource: `${origin}/mcp`, authorization_servers: [origin] });
  const as = await get("/.well-known/oauth-authorization-server");
  assert.equal(as.status, 200);
  const meta = JSON.parse(as.text);
  assert.equal(meta.registration_endpoint, `${origin}/oauth/register`);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  assert.doesNotMatch(prm.text + as.text, /trydemigod/);
});

test("without it native OAuth stays off: no resource_metadata challenge, no metadata document, no registration", async t => {
  const get = await boot(t, {});
  assert.doesNotMatch((await get("/mcp", initialize)).headers["www-authenticate"] ?? "", /resource_metadata/);
  assert.equal((await get("/.well-known/oauth-protected-resource/mcp")).status, 404);
  assert.equal((await get("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
});
