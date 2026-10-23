// CURE-4416-REMOVE specimens: the consent surface promises that removing
// an agent ends its access everywhere; stage 2 shipped oauthGrantAgents
// .remove() with no route reaching it, a refresh-time resurrection path
// for unstamped families, and grant permissions snapshotted from the
// owner at materialization. These specimens pin the cured behaviour:
//   1. DELETE /api/oauth/agents/{id} (account session + CSRF, owner-only)
//      removes the agent: binding + identity revoked, the client's live
//      token families revoked, access refused at REST and MCP.
//   2. A removed agent cannot re-mint: refresh of a pre-stage-2 unstamped
//      family refuses instead of lazy-binding a successor, refresh of a
//      stamped family refuses, and a pre-removal code no longer exchanges.
//   3. Permissions evaluate at use against the owner's CURRENT ceiling:
//      narrowing the owner narrows the grant's effective permissions;
//      re-widening restores only up to the grant's own (stored) set.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createOAuthProvider } from "../server/oauth-provider.mjs";
import { createGrantAgentResolver, createGrantAgentRemovalCheck } from "../server/oauth-grant-agents.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const ALL_SCOPES = ["rooms:read", "chat:read", "chat:write", "work:read", "work:write"];
const CLIENTS = [
  { clientId: "muse", name: "Claude", redirectUris: ["https://muse.ai/oauth/callback"] },
  { clientId: "project-room-macos", name: "Project Room", redirectUris: ["https://mac.example/cb"] },
];

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-door-auth-stage2-remove-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("annex"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  store.bindHumanAccount("annex", "owner", "account-owner");
  store.updateAccountProfile("account-owner", { displayName: "John" });
  const ownerKey = store.issueAccessKey("commons", "owner", 7 * 86400000, "account-owner");
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "plain", displayName: "Plain Member", kind: "human", permissions: [] },
  });
  store.bindHumanAccount("commons", "plain", "account-plain");
  const server = createRoomServer({ store, connectorClients: CLIENTS });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = "GET", token, cookie, headers, data } = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
        ...(headers ?? {}),
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };
  const loginFor = accountId => {
    const key = store.issueAccountAccessKey(accountId);
    const slot = store.createAccountSessionSlot();
    const session = store.loginAccountSession(slot.token, key, 0);
    return {
      cookie: `account_session=${slot.token}`,
      sessionBinding: session.sessionBinding,
      csrf: session.csrf,
      readHeaders: { cookie: `account_session=${slot.token}`, "x-session-binding": session.sessionBinding },
      writeHeaders: {
        cookie: `account_session=${slot.token}`, "x-session-binding": session.sessionBinding,
        "x-csrf-token": session.csrf, origin,
      },
    };
  };
  const ownerLogin = loginFor("account-owner");
  const provider = createOAuthProvider({
    db: store.db, clock: () => store.now(),
    resolveGrantAgent: createGrantAgentResolver(store),
    isGrantAgentRemoved: createGrantAgentRemovalCheck(store),
  });
  for (const client of CLIENTS) provider.registerClient(client);
  const mint = (clientId, userId, scopes) => {
    const client = CLIENTS.find(entry => entry.clientId === clientId);
    const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
    const codeChallenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
    const { code } = provider.issueCode({
      clientId, userId, redirectUri: client.redirectUris[0], scopes, codeChallenge,
    });
    return provider.exchangeCode({
      code, clientId, redirectUri: client.redirectUris[0], codeVerifier: verifier,
    });
  };
  // An unstamped (pre-stage-2 shape) family: minted by a provider with no
  // resolver wired, so its records carry principal null.
  const bareMint = (clientId, userId, scopes) => {
    const bare = createOAuthProvider({ db: store.db, clock: () => store.now() });
    bare.registerClient(CLIENTS.find(entry => entry.clientId === clientId));
    const client = CLIENTS.find(entry => entry.clientId === clientId);
    const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
    const codeChallenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
    const { code } = bare.issueCode({
      clientId, userId, redirectUri: client.redirectUris[0], scopes, codeChallenge,
    });
    return bare.exchangeCode({
      code, clientId, redirectUri: client.redirectUris[0], codeVerifier: verifier,
    });
  };
  // Full HTTP approval that stops at the code (no exchange).
  const issueCodeViaHttp = async client => {
    const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
    const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
    const query = "/oauth/authorize?response_type=code&client_id=" + client.clientId
      + "&redirect_uri=" + encodeURIComponent(client.redirectUris[0])
      + "&scope=" + encodeURIComponent(ALL_SCOPES.join(" "))
      + "&state=s2&code_challenge=" + challenge + "&code_challenge_method=S256";
    const screen = await fetch(origin + query, { headers: { cookie: ownerLogin.cookie } });
    assert.equal(screen.status, 200);
    const html = await screen.text();
    const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    assert.ok(csrf, "consent form carries a csrf token");
    const formBody = "decision=allow&client_id=" + client.clientId
      + "&redirect_uri=" + encodeURIComponent(client.redirectUris[0])
      + "&scope=" + encodeURIComponent(ALL_SCOPES.join(" "))
      + "&state=s2&code_challenge=" + challenge
      + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(csrf);
    const consent = await fetch(origin + "/oauth/authorize", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: ownerLogin.cookie, origin },
      body: formBody,
    });
    assert.equal(consent.status, 302);
    const code = new URL(consent.headers.get("location")).searchParams.get("code");
    assert.ok(code);
    return { code, verifier };
  };
  const tokenPost = data => fetch(origin + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify(data),
  }).then(async response => ({ status: response.status, body: await response.json().catch(() => null) }));
  const rpc = async (method, params, token) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };
  const call = (name, args, token) => rpc("tools/call", { name, arguments: args }, token);
  const removeAgent = (clientId, login) => fetch(origin + `/api/oauth/agents/${clientId}`, {
    method: "DELETE", headers: login.writeHeaders,
  }).then(async response => ({ status: response.status, body: await response.json().catch(() => null) }));
  return { store, origin, request, mint, bareMint, issueCodeViaHttp, tokenPost, provider, ownerKey, ownerLogin, loginFor, call, removeAgent };
}

const memberOf = (store, roomId, memberId) => store.room(roomId).state.members[memberId];

test("removal route: the owner removes the agent and its access ends at both doors, in both rooms", async t => {
  const f = await serve(t);
  const { accessToken, refreshToken } = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(accessToken);
  assert.equal((await f.request("/api/rooms/commons/work-claims-read", { token: accessToken })).status, 200);
  assert.equal((await f.request("/api/rooms/annex/work-claims-read", { token: accessToken })).status, 200);
  const check = await f.call("room_check_access", { roomId: "commons" }, accessToken);
  assert.equal(check.body.result?.isError, undefined, JSON.stringify(check.body));

  const removed = await f.removeAgent("muse", f.ownerLogin);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.removed, true);
  assert.equal(removed.body.identityId, grant.agentIdentityId);
  assert.ok(removed.body.revoked >= 2, "the client's live families were revoked with the removal");

  // Access tokens refuse at both doors; the token itself no longer verifies.
  assert.equal(f.provider.verifyAccessToken(accessToken), null);
  assert.equal((await f.request("/api/rooms/commons/work-claims-read", { token: accessToken })).status, 401);
  assert.equal((await f.request("/api/rooms/annex/work-claims-read", { token: accessToken })).status, 401);
  const mcpAfter = await f.call("room_check_access", { roomId: "commons" }, accessToken);
  assert.equal(mcpAfter.status, 401, JSON.stringify(mcpAfter.body));
  // Refresh refuses too: the removal revoked the family, so the refusal
  // carries the family's own revoked shape.
  const refreshed = await f.tokenPost({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "muse" });
  assert.equal(refreshed.status, 400);
  assert.equal(refreshed.body.error, "invalid_request");
  assert.match(refreshed.body.error_description, /refresh token revoked/);
  // Binding + identity revoked; members deactivated; the human untouched.
  const binding = f.store.oauthGrantAgents.binding({ accountId: "account-owner", clientId: "muse" });
  assert.ok(binding.revokedAt, "binding revoked");
  const identity = f.store.db.prepare("SELECT revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?")
    .get(grant.agentIdentityId);
  assert.ok(identity.revokedAt, "identity revoked");
  assert.equal(memberOf(f.store, "commons", grant.agentIdentityId).active, false);
  assert.equal(f.store.account("account-owner").active, true);
  assert.ok(memberOf(f.store, "commons", "owner").active);
  const sessions = await f.request("/api/oauth/sessions", { headers: f.ownerLogin.readHeaders });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.body.sessions.some(s => s.clientId === "muse"), false, "the removed client's families leave the sessions view");
});

test("removal route: a non-owner's attempt refuses and changes nothing; an unknown agent 404s", async t => {
  const f = await serve(t);
  const { accessToken } = f.mint("muse", "account-owner", ALL_SCOPES);
  assert.equal((await f.request("/api/rooms/commons/work-claims-read", { token: accessToken })).status, 200);
  const plainLogin = f.loginFor("account-plain");
  const attempt = await f.removeAgent("muse", plainLogin);
  assert.equal(attempt.status, 404, JSON.stringify(attempt.body));
  assert.equal(attempt.body.error.code, "agent_not_found");
  // Nothing changed: binding live, grant still spends.
  const binding = f.store.oauthGrantAgents.binding({ accountId: "account-owner", clientId: "muse" });
  assert.equal(binding.revokedAt, null);
  assert.equal((await f.request("/api/rooms/commons/work-claims-read", { token: accessToken })).status, 200);
  // The owner removing a client they never connected also 404s.
  const unknown = await f.removeAgent("never-connected", f.ownerLogin);
  assert.equal(unknown.status, 404);
  // No account session at all refuses as unauthenticated.
  const anon = await fetch(f.origin + "/api/oauth/agents/muse", { method: "DELETE" });
  assert.equal(anon.status, 401);
});

test("no resurrection: refresh of an unstamped pre-stage-2 family after removal refuses instead of re-binding", async t => {
  const f = await serve(t);
  // A stamped family establishes the binding; an unstamped family (minted
  // by an unwired provider, principal null) coexists for the same pair.
  const stamped = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(stamped.accessToken);
  const legacy = f.bareMint("muse", "account-owner", ALL_SCOPES);
  const legacyGrant = f.provider.verifyAccessToken(legacy.accessToken);
  assert.equal(legacyGrant.principal, null, "the legacy family is unstamped");

  const removed = await f.removeAgent("muse", f.ownerLogin);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const refreshed = await f.tokenPost({ grant_type: "refresh_token", refresh_token: legacy.refreshToken, client_id: "muse" });
  assert.equal(refreshed.status, 400, JSON.stringify(refreshed.body));
  // The route revoked the family, so its own revoked shape answers; the
  // provider-predicate shape is pinned separately below.
  assert.equal(refreshed.body.error, "invalid_request");
  assert.match(refreshed.body.error_description, /refresh token revoked/);
  // No successor was minted: the binding still names the removed identity,
  // still revoked, and that identity is still revoked.
  const binding = f.store.oauthGrantAgents.binding({ accountId: "account-owner", clientId: "muse" });
  assert.equal(binding.identityId, grant.agentIdentityId);
  assert.ok(binding.revokedAt, "binding stays revoked after the refresh attempt");
  const identity = f.store.db.prepare("SELECT revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?")
    .get(grant.agentIdentityId);
  assert.ok(identity.revokedAt, "identity stays revoked");
});

test("no resurrection: even without the route's family revocation, a removed binding refuses refresh at the provider", async t => {
  const f = await serve(t);
  const stamped = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(stamped.accessToken);
  const legacy = f.bareMint("muse", "account-owner", ALL_SCOPES);
  // Store-level removal only — no route, so no family revocation: the
  // provider's removal predicate is the only thing standing between
  // these refresh tokens and a re-mint.
  f.store.oauthGrantAgents.remove({ accountId: "account-owner", clientId: "muse" });
  for (const pair of [stamped, legacy]) {
    const refreshed = await f.tokenPost({ grant_type: "refresh_token", refresh_token: pair.refreshToken, client_id: "muse" });
    assert.equal(refreshed.status, 400, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.error, "invalid_grant");
    assert.match(refreshed.body.error_description, /agent was removed/);
  }
  // And the removed agent's access token no longer verifies.
  assert.equal(f.provider.verifyAccessToken(stamped.accessToken), null);
  // No successor: the binding still names the removed identity, revoked.
  const binding = f.store.oauthGrantAgents.binding({ accountId: "account-owner", clientId: "muse" });
  assert.equal(binding.identityId, grant.agentIdentityId);
  assert.ok(binding.revokedAt, "binding stays revoked");
});

test("no resurrection: a code approved before removal no longer exchanges after it", async t => {
  const f = await serve(t);
  const { code, verifier } = await f.issueCodeViaHttp(CLIENTS[0]);
  const removed = await f.removeAgent("muse", f.ownerLogin);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const exchanged = await f.tokenPost({
    grant_type: "authorization_code", code,
    redirect_uri: CLIENTS[0].redirectUris[0], client_id: "muse", code_verifier: verifier,
  });
  assert.equal(exchanged.status, 400, JSON.stringify(exchanged.body));
  assert.equal(exchanged.body.error, "invalid_grant");
});

test("ceiling at use: narrowing the owner narrows the grant's effective permissions; re-widening restores only the granted set", async t => {
  const f = await serve(t);
  const { accessToken } = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(accessToken);
  const before = await f.call("room_check_access", { roomId: "commons" }, accessToken);
  assert.equal(before.body.result?.isError, undefined, JSON.stringify(before.body));
  const granted = [...memberOf(f.store, "commons", grant.agentIdentityId).permissions];
  assert.ok(granted.length > 0, "the agent was granted a non-empty safe set");
  assert.deepEqual(before.body.result.structuredContent.permissions, granted);

  // The owner is narrowed to membership administration only.
  const owner = memberOf(f.store, "commons", "owner");
  f.store.command(f.ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "owner", expectedMemberRevision: owner.revision, permissions: ["manage_members"], active: true },
  });
  const narrowed = await f.call("room_check_access", { roomId: "commons" }, accessToken);
  assert.equal(narrowed.body.result?.isError, undefined, JSON.stringify(narrowed.body));
  assert.deepEqual(narrowed.body.result.structuredContent.permissions, [],
    "effective permissions are the owner's current ceiling intersected with the grant's set");
  const bound = f.store.authenticateOAuthAgent(grant, "commons");
  assert.deepEqual([...bound.member.permissions], []);
  // The stored member keeps the grant's own set (evaluate-at-use, not a
  // destructive re-stamp).
  assert.deepEqual([...memberOf(f.store, "commons", grant.agentIdentityId).permissions], granted);

  // Re-widening the owner restores the grant's set — and no more than it.
  const owner2 = memberOf(f.store, "commons", "owner");
  f.store.command(f.ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: {
      memberId: "owner", expectedMemberRevision: owner2.revision,
      permissions: ["manage_members", "invite_member", "steer", "accept_work", "complete_work", "verify", "decide"],
      active: true,
    },
  });
  const widened = await f.call("room_check_access", { roomId: "commons" }, accessToken);
  assert.deepEqual(widened.body.result.structuredContent.permissions, granted,
    "re-widening restores exactly the grant's own set, never the owner's wider set");
});
