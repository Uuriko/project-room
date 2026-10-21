// /mcp/chatgpt OAuth bridge: a Room-issued access token acts as the signed-in
// account's own member in its rooms. Valid, expired, wrong-audience and
// revoked tokens, plus scope enforcement. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createOAuthProvider } from "../server/oauth-provider.mjs";
import { createOAuthMcpBridge } from "../server/oauth-mcp-bridge.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { dispatchRoomMcp } from "../server/mcp-http.mjs";

const ORIGIN = "https://room.example";
const AUDIENCE = ORIGIN + "/mcp/chatgpt";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const ALL = ["rooms:read", "chat:read", "chat:write", "work:read", "work:write"];

function setup(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  let clock = 1_800_000_000_000;
  const provider = createOAuthProvider({ clock: () => clock });
  provider.registerClient({ clientId: "chatgpt-test", name: "ChatGPT", redirectUris: [REDIRECT] });
  f.store.createAccount("acct-potter");
  f.store.initialize(initialRoom("room-potter"));
  f.store.bindHumanAccount("room-potter", "owner", "acct-potter");
  f.store.initialize(initialRoom("room-other"));
  const resolve = createOAuthMcpBridge({ oauthProvider: provider, store: f.store, audiences: [AUDIENCE] });
  const roomMcp = createHostedRoomMcp(f.store);
  const mint = ({ resource = AUDIENCE, scopes = ALL } = {}) => {
    const verifier = "v".repeat(48);
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const { code } = provider.issueCode({ clientId: "chatgpt-test", userId: "acct-potter", redirectUri: REDIRECT, scopes, codeChallenge, resource });
    return provider.exchangeCode({ code, clientId: "chatgpt-test", redirectUri: REDIRECT, codeVerifier: verifier });
  };
  const call = (token, name, args) => dispatchRoomMcp(
    { jsonrpc: "2.0", id: "1", method: "tools/call", params: { name, arguments: args } },
    { mcpUrl: ORIGIN + "/mcp", authorization: `Bearer ${token}`, roomMcp, pathname: "/mcp/chatgpt", resolveOAuthBearer: resolve });
  return { f, provider, resolve, mint, call, advance: ms => { clock += ms; } };
}

test("a valid token reaches the account's own room as its member", async t => {
  const { mint, call, resolve } = setup(t);
  const tokens = mint();
  assert.match(resolve(tokens.accessToken), /^Bearer pri_/);
  const reply = await call(tokens.accessToken, "room_who_is_working", { roomId: "room-potter" });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.notEqual(reply.result?.isError, true, JSON.stringify(reply.result));
  // Same account, a room it is not in: refused by normal room permissions.
  const other = await call(tokens.accessToken, "room_who_is_working", { roomId: "room-other" });
  assert.ok(other.error || other.result?.isError, "must not read a room the account is not in");
});

test("an expired token is refused", async t => {
  const { mint, call, advance } = setup(t);
  const tokens = mint();
  advance(24 * 60 * 60 * 1000);
  const reply = await call(tokens.accessToken, "room_who_is_working", { roomId: "room-potter" });
  assert.equal(reply.error?.code, -32001);
});

test("a token minted for another audience, or none, is refused", async t => {
  const { mint, call } = setup(t);
  for (const resource of ["https://other.example/mcp", null]) {
    const tokens = mint({ resource });
    const reply = await call(tokens.accessToken, "room_who_is_working", { roomId: "room-potter" });
    assert.equal(reply.error?.code, -32001, String(resource));
  }
});

test("a revoked token is refused", async t => {
  const { mint, call, provider } = setup(t);
  const tokens = mint();
  assert.equal(provider.revoke(tokens.accessToken), true);
  const reply = await call(tokens.accessToken, "room_who_is_working", { roomId: "room-potter" });
  assert.equal(reply.error?.code, -32001);
});

test("a token without the tool's scopes is refused", async t => {
  const { mint, call } = setup(t);
  const tokens = mint({ scopes: ["rooms:read"] });
  const reply = await call(tokens.accessToken, "room_post", { roomId: "room-potter", body: "hi" });
  assert.equal(reply.error?.code, -32001);
});
