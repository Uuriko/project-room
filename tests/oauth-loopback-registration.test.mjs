// Self-host loopback registration: with ROOM_MCP_OAUTH_LOOPBACK on, a native
// MCP client (Claude Code, Codex) can register the loopback callback it is about
// to listen on and then use the normal consent flow. Off by default; refuses
// every non-loopback redirect; grants nothing by itself.
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { defaultServerArgs } from "../server/boot-options.mjs";
import { isLoopbackRedirectUri } from "../server/oauth-client-contract.mjs";

const ORIGIN = "https://room.example";
const configured = { clientId: "loopback-test-configured", name: "Configured MCP client", redirectUris: ["https://client.example/callback"] };

const tableCount = (store, table) => store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  ? store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n : 0;

async function fixture(t, options = {}) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const server = createRoomServer({ store, origin: ORIGIN, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const call = (path, { method = "GET", data, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { Host: "room.example", ...(data ? { "Content-Type": "application/json" } : {}), ...headers } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, body }); });
    });
    req.on("error", reject);
    req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  const counts = () => Object.fromEntries(["credentials", "agent_identities", "member_accounts", "oauth_provider_access_tokens", "oauth_provider_refresh_tokens"]
    .map(table => [table, tableCount(store, table)]));
  return { store, call, counts };
}
const register = (call, redirect, extra = {}) => call("/oauth/register", { method: "POST", data: { client_name: "Claude Code", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...extra } });

test("isLoopbackRedirectUri accepts only http loopback callbacks with no userinfo, query or fragment", () => {
  for (const ok of ["http://127.0.0.1:53124/callback", "http://localhost:8080/callback", "http://[::1]:49152/callback", "http://localhost/callback", "http://127.0.0.1/"])
    assert.equal(isLoopbackRedirectUri(ok), true, ok);
  for (const bad of ["https://127.0.0.1:1/callback", "http://127.0.0.1.evil.example/callback", "http://localhost.evil.example/callback", "http://evil.example/callback",
    "http://0.0.0.0:80/callback", "http://127.0.0.2:80/callback", "http://user:pw@127.0.0.1:1/callback", "http://127.0.0.1:1/callback?code=x", "http://127.0.0.1:1/callback#frag",
    "javascript:alert(1)", "//127.0.0.1/callback", "", null, undefined, 5, `http://127.0.0.1/${"a".repeat(300)}`])
    assert.equal(isLoopbackRedirectUri(bad), false, String(bad));
});

test("off by default: with no client list and no flag, registration does not exist", async t => {
  const { call } = await fixture(t);
  assert.equal((await register(call, "http://127.0.0.1:53124/callback")).status, 404);
  assert.equal((await call("/.well-known/oauth-protected-resource/mcp")).status, 404);
});

test("flag off with a configured client list: a loopback redirect is still refused", async t => {
  const { call } = await fixture(t, { mcpOAuthClients: [configured] });
  assert.equal((await register(call, "http://127.0.0.1:53124/callback")).status, 400);
  assert.equal((await register(call, configured.redirectUris[0])).status, 201);
});

test("flag on with no client list: discovery appears and a loopback client registers, granting nothing", async t => {
  const { call, counts } = await fixture(t, { mcpOAuthLoopback: true });
  const resource = await call("/.well-known/oauth-protected-resource/mcp");
  assert.equal(resource.status, 200);
  assert.equal(resource.body.resource, `${ORIGIN}/mcp`);
  const server = await call("/.well-known/oauth-authorization-server");
  assert.equal(server.body.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(server.body.code_challenge_methods_supported, ["S256"]);
  const challenge = await call("/mcp", { method: "POST", headers: { Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } } });
  assert.equal(challenge.status, 401, challenge.text);
  assert.match(challenge.headers["www-authenticate"], /resource_metadata="https:\/\/room\.example\/\.well-known\/oauth-protected-resource\/mcp"/);

  const before = counts();
  for (const redirect of ["http://127.0.0.1:53124/callback", "http://localhost:8080/callback", "http://[::1]:49152/callback"]) {
    const created = await register(call, redirect);
    assert.equal(created.status, 201, `${redirect}: ${created.text}`);
    assert.equal(created.headers["cache-control"], "no-store");
    assert.match(created.body.client_id, /^mcp_dcr_/);
    assert.deepEqual(created.body.redirect_uris, [redirect]);
    assert.equal(created.body.token_endpoint_auth_method, "none");
    assert.equal(created.body.client_secret, undefined);
    assert.equal(created.body.access_token, undefined);
  }
  assert.deepEqual(counts(), before, "registration must create no credential, identity, account link or token");
});

test("flag on: every non-loopback or malformed redirect, and every non-public client shape, is refused", async t => {
  const { call, store } = await fixture(t, { mcpOAuthLoopback: true });
  const clientCount = () => tableCount(store, "oauth_provider_clients");
  const clientsBefore = clientCount();
  for (const redirect of ["https://evil.example/callback", "http://evil.example/callback", "https://127.0.0.1:53124/callback", "http://127.0.0.1.evil.example/callback",
    "http://localhost.evil.example:80/callback", "http://user:pw@127.0.0.1:53124/callback", "http://127.0.0.1:53124/callback?next=https://evil.example",
    "http://127.0.0.1:53124/callback#x", "http://0.0.0.0:53124/callback", "projectroom://callback", "javascript:alert(1)"])
    assert.equal((await register(call, redirect)).status, 400, redirect);
  const ok = "http://127.0.0.1:53124/callback";
  assert.equal((await register(call, ok, { token_endpoint_auth_method: "client_secret_post" })).status, 400);
  assert.equal((await register(call, ok, { grant_types: ["client_credentials"] })).status, 400);
  assert.equal((await register(call, ok, { response_types: ["token"] })).status, 400);
  assert.equal((await call("/oauth/register", { method: "POST", data: { redirect_uris: [ok, "https://evil.example/callback"] } })).status, 400, "one bad URI refuses the whole registration");
  assert.equal((await call("/oauth/register", { method: "POST", data: { redirect_uris: Array(6).fill(ok) } })).status, 400);
  assert.equal(clientCount(), clientsBefore, "no refused request may leave a client behind");
});

test("end to end: a native client registers its loopback callback, joins with an invite code in the browser, and acts as the invited agent", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const invitation = store.invites.create(owner, "commons", { profile: "contribute" });
  const server = createRoomServer(defaultServerArgs({ store, origin: ORIGIN, env: { ROOM_MCP_OAUTH_LOOPBACK: "1" } }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers: { Host: "room.example", ...headers } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end(body);
  });
  const redirect = "http://127.0.0.1:53124/callback";
  const verifier = "x".repeat(43), challenge = createHash("sha256").update(verifier).digest("base64url");
  const registered = await send("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  assert.equal(registered.status, 201, registered.text);
  const clientId = JSON.parse(registered.text).client_id;
  const authorizeQuery = (uri, id = clientId) => new URLSearchParams({ client_id: id, redirect_uri: uri, response_type: "code", scope: "rooms:read chat:read chat:write work:read work:write",
    state: "native-state", code_challenge: challenge, code_challenge_method: "S256", resource: `${ORIGIN}/mcp`, connection: "invite" });
  // A signed-out browser is offered the invite screen, never a code or a redirect to the callback.
  const start = await send(`/oauth/authorize?${authorizeQuery(redirect)}`);
  assert.equal(start.status, 200, start.text);
  assert.match(start.text, /No Project Room signup/);
  assert.match(start.headers["content-security-policy"], /form-action 'self'/);
  // Another port on the same host is not the registered callback.
  assert.equal((await send(`/oauth/authorize?${authorizeQuery("http://127.0.0.1:53125/callback")}`)).status, 400);
  // An unregistered client id is not an MCP client: it is sent to account sign-in, where validation refuses it.
  const unknown = await send(`/oauth/authorize?${authorizeQuery(redirect, "mcp_dcr_does-not-exist")}`);
  assert.equal(unknown.status, 302);
  assert.ok(unknown.headers.location.startsWith("/?oauth=login"));
  const nonce = start.text.match(/name="nonce" value="([^"]+)"/)[1];
  const cookie = start.headers["set-cookie"][0].split(";")[0];
  const accountsBefore = store.db.prepare("SELECT count(*) n FROM accounts").get().n;
  const allow = await send("/oauth/invite", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ nonce, decision: "allow", invitation: `${ORIGIN}/#agent-invite/${invitation.code}`, display_name: "Loopback agent" }).toString() });
  assert.equal(allow.status, 302, allow.text);
  const location = new URL(allow.headers.location);
  assert.equal(location.origin + location.pathname, redirect, "the code goes to the exact registered callback");
  assert.equal(location.searchParams.get("state"), "native-state");
  const code = location.searchParams.get("code");
  // A wrong redirect port at the token step is refused and does not spend the code.
  const wrongPort = await send("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: "http://127.0.0.1:53125/callback", code_verifier: verifier, resource: `${ORIGIN}/mcp` }).toString() });
  assert.equal(wrongPort.status, 400);
  const exchange = await send("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier, resource: `${ORIGIN}/mcp` }).toString() });
  assert.equal(exchange.status, 200, exchange.text);
  const tokens = JSON.parse(exchange.text);
  const rpc = await send("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_check_access", arguments: {} } }) });
  assert.equal(rpc.status, 200, rpc.text);
  const access = JSON.parse(rpc.text).result.structuredContent;
  assert.equal(access.roomId, "commons");
  assert.equal(store.db.prepare("SELECT count(*) n FROM accounts").get().n, accountsBefore, "no human account is created");
  assert.equal(store.db.prepare("SELECT count(*) n FROM agent_invite_codes WHERE redeemed_at IS NOT NULL").get().n, 1, "the one-time code was spent");
});
