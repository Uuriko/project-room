// AGENT-DOOR-AUTH stage 2: an approved OAuth grant acts as a separate
// agent member the approving human owns — never as the human. (Principal
// model: Codex's decision under the standing delegation, room seq 16576,
// agreed by Jill at seq 16573; built under John's 2026-10-20 direction to
// close the OAuth work out.)
//
// Stage 1 bound the grant to the consenting account's HUMAN member
// (store.authenticateOAuthAccount). Stage 2 replaces that binding for
// connector clients:
// - at approval time the provider's resolveGrantAgent hook mints or binds
//   one agent identity per (account, client) — display name "<owner>'s
//   <client>" — and the grant's tokens carry that principal;
// - at both doors (REST roomAuth, /mcp) the grant binds to the AGENT
//   member (materialized on first room use, accountable to the owner's
//   human member), so journaled actions attribute to the agent member;
// - removal isolates in both directions: removing the agent member (in a
//   room, or the whole agent) kills the grant there/everywhere and never
//   touches the human's account, memberships, or sign-in; revoking the
//   grant never touches the agent identity's other doors or the human;
// - the first-party Mac app client (project-room-macos) is an account
//   sign-in client by its own consent contract, so it keeps the stage-1
//   account-principal binding (named carve-out);
// - an agent-principal token with no binding fails closed — it never
//   falls back to acting as the human;
// - GET /api/oauth/sessions shows the agent principal and its receiving
//   status: listening (live listener lease) vs connected (fresh wakeable
//   host observation) vs pull-only (capability only) — the seq-16573
//   three-state distinction.
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
import { createGrantAgentResolver } from "../server/oauth-grant-agents.mjs";
import { createWork, claimWork } from "../server/work-claims.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const ALL_SCOPES = ["rooms:read", "chat:read", "chat:write", "work:read", "work:write"];
const CLIENTS = [
  { clientId: "muse", name: "Claude", redirectUris: ["https://muse.ai/oauth/callback"] },
  { clientId: "project-room-macos", name: "Project Room", redirectUris: ["https://mac.example/cb"] },
];

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-door-auth-stage2-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("annex"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  store.bindHumanAccount("annex", "owner", "account-owner");
  store.updateAccountProfile("account-owner", { displayName: "John" });
  const ownerKey = store.issueAccessKey("commons", "owner", 7 * 86400000, "account-owner");
  // A plain human member (no permissions, no invite authority) with its
  // own account — the admission-rule fixture.
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "plain", displayName: "Plain Member", kind: "human", permissions: [] },
  });
  store.bindHumanAccount("commons", "plain", "account-plain");
  store.workClaims.set("commons", createWork({ id: "claim-1", title: "seeded claim-1" }, { now: Date.now() - 60000 }));
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
  // The owner's account session (the human's own sign-in door). The
  // account-session endpoints also require the session-binding header.
  const accountKey = store.issueAccountAccessKey("account-owner");
  const slot = store.createAccountSessionSlot();
  const login = store.loginAccountSession(slot.token, accountKey, 0);
  const accountCookie = `account_session=${slot.token}`;
  const accountHeaders = { cookie: accountCookie, "x-session-binding": login.sessionBinding };
  // Provider minting with the production resolver wired (the same factory
  // http.mjs injects into the server's own provider).
  const provider = createOAuthProvider({
    db: store.db, clock: () => store.now(),
    resolveGrantAgent: createGrantAgentResolver(store),
  });
  for (const client of CLIENTS) provider.registerClient(client);
  const mint = (clientId, userId, scopes) => {
    const client = CLIENTS.find(entry => entry.clientId === clientId);
    const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
    const codeChallenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
    const { code } = provider.issueCode({
      clientId, userId, redirectUri: client.redirectUris[0], scopes, codeChallenge,
    });
    const pair = provider.exchangeCode({
      code, clientId, redirectUri: client.redirectUris[0], codeVerifier: verifier,
    });
    return pair;
  };
  // The full production approval path: consent screen -> allow -> code ->
  // token exchange, all over HTTP against the server's own provider.
  const approveViaHttp = async (client, scopes) => {
    const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
    const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
    const query = "/oauth/authorize?response_type=code&client_id=" + client.clientId
      + "&redirect_uri=" + encodeURIComponent(client.redirectUris[0])
      + "&scope=" + encodeURIComponent(scopes.join(" "))
      + "&state=s2&code_challenge=" + challenge + "&code_challenge_method=S256";
    const screen = await fetch(origin + query, { headers: { cookie: accountCookie } });
    assert.equal(screen.status, 200);
    const html = await screen.text();
    const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    assert.ok(csrf, "consent form carries a csrf token");
    const formBody = "decision=allow&client_id=" + client.clientId
      + "&redirect_uri=" + encodeURIComponent(client.redirectUris[0])
      + "&scope=" + encodeURIComponent(scopes.join(" "))
      + "&state=s2&code_challenge=" + challenge
      + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(csrf);
    const consent = await fetch(origin + "/oauth/authorize", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: accountCookie, origin },
      body: formBody,
    });
    assert.equal(consent.status, 302);
    const code = new URL(consent.headers.get("location")).searchParams.get("code");
    assert.ok(code);
    const tokenResponse = await fetch(origin + "/oauth/token", {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        grant_type: "authorization_code", code,
        redirect_uri: client.redirectUris[0], client_id: client.clientId, code_verifier: verifier,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    return tokenResponse.json();
  };
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
  return { store, origin, request, mint, approveViaHttp, provider, ownerKey, accountCookie, accountHeaders, call };
}

const memberOf = (store, roomId, memberId) => store.room(roomId).state.members[memberId];

test("approval over HTTP mints an owned agent identity and the token carries that principal", async t => {
  const f = await serve(t);
  const tokens = await f.approveViaHttp(CLIENTS[0], ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(tokens.access_token);
  assert.equal(grant.userId, "account-owner");
  assert.equal(grant.clientId, "muse");
  assert.equal(grant.principal, "agent");
  assert.ok(grant.agentIdentityId, "grant carries the bound agent identity");
  assert.notEqual(grant.agentIdentityId, "account-owner");
  const binding = f.store.oauthGrantAgents.binding({ accountId: "account-owner", clientId: "muse" });
  assert.equal(binding.identityId, grant.agentIdentityId);
  assert.equal(binding.displayName, "John's Claude");
  assert.equal(binding.revokedAt, null);
  const identity = f.store.db.prepare("SELECT display_name AS displayName FROM agent_identities WHERE identity_id=?")
    .get(grant.agentIdentityId);
  assert.equal(identity.displayName, "John's Claude");
});

test("approval binds, never re-mints: same client reuses the identity, a second client gets its own", async t => {
  const f = await serve(t);
  const first = f.mint("muse", "account-owner", ALL_SCOPES);
  const second = f.mint("muse", "account-owner", ALL_SCOPES);
  const g1 = f.provider.verifyAccessToken(first.accessToken);
  const g2 = f.provider.verifyAccessToken(second.accessToken);
  assert.equal(g1.agentIdentityId, g2.agentIdentityId);
  // Refresh keeps the family's agent principal.
  const rotated = f.provider.refresh({ refreshToken: first.refreshToken, clientId: "muse" });
  const g3 = f.provider.verifyAccessToken(rotated.accessToken);
  assert.equal(g3.agentIdentityId, g1.agentIdentityId);
  assert.equal(g3.principal, "agent");
});

test("REST door: grant actions attribute to the agent member, never the human member", async t => {
  const f = await serve(t);
  const { accessToken } = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(accessToken);
  // The agent holds the seeded claim (closing is a holder action; unlike
  // the stage-1 human binding, the agent is not the room owner, so it
  // acts on its own work — the attribution this stage exists to prove).
  const seeded = f.store.workClaims.get("commons", "claim-1");
  f.store.workClaims.set("commons", claimWork(seeded, grant.agentIdentityId, { now: Date.now() }));
  const closed = await f.request("/api/rooms/commons/work-claims/claim-1/close", {
    method: "POST", token: accessToken, data: {},
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.state, "closed");
  const claim = f.store.workClaims.get("commons", "claim-1");
  const stamp = claim.history[claim.history.length - 1];
  assert.equal(stamp.agentId, grant.agentIdentityId, "claim history stamps the agent member");
  assert.notEqual(stamp.agentId, "owner");
  // The agent member exists in the room, owned by the human member.
  const agent = memberOf(f.store, "commons", grant.agentIdentityId);
  assert.ok(agent, "agent member materialized in the room");
  assert.equal(agent.kind, "agent");
  assert.equal(agent.accountableHumanId, "owner");
  assert.equal(agent.displayName, "John's Claude");
  assert.ok(agent.active);
  // The human member is untouched by the grant's action.
  const human = memberOf(f.store, "commons", "owner");
  assert.equal(human.kind, "human");
  assert.ok(human.active);
});

test("MCP door: grant actions attribute to the agent member", async t => {
  const f = await serve(t);
  // The land queue reads PR data through its GitHub fetch (stage-1 mock shape).
  f.store.landQueue.configure({
    token: "<MASKED_SECRET_001>",
    fetchImpl: async url => {
      let body = {
        title: "Land the queue", merged: false, merge_commit_sha: null,
        mergeable: true, mergeable_state: "clean", head: { sha: "b".repeat(40) },
      };
      if (url.includes("/check-runs")) body = { check_runs: [{ status: "completed", conclusion: "success" }] };
      else if (url.endsWith("/status")) body = { state: "success" };
      return { status: 200, ok: true, json: async () => body };
    },
  });
  const { accessToken } = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(accessToken);
  const added = await f.call("add_land_item", {
    roomId: "commons", repo: "Uuriko/project-room", prNumber: 4242,
  }, accessToken);
  assert.equal(added.body.result?.isError, undefined, JSON.stringify(added.body));
  const item = added.body.result.structuredContent.item;
  assert.equal(item.addedByMemberId, grant.agentIdentityId);
  assert.notEqual(item.addedByMemberId, "owner");
  const queue = await f.call("list_land_queue", { roomId: "commons" }, accessToken);
  const listed = queue.body.result.structuredContent.items.find(entry => entry.prNumber === 4242);
  assert.ok(listed, "land item recorded");
  assert.equal(listed.addedByMemberId, grant.agentIdentityId);
});

test("removal specimen: removing the agent member kills the grant in that room; the human is untouched", async t => {
  const f = await serve(t);
  const { accessToken } = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(accessToken);
  const before = await f.request("/api/rooms/commons/work-claims-read", { token: accessToken });
  assert.equal(before.status, 200);
  // The room owner removes the agent member (ordinary member removal).
  const agentMember = memberOf(f.store, "commons", grant.agentIdentityId);
  f.store.command(f.ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: {
      memberId: grant.agentIdentityId, expectedMemberRevision: agentMember.revision,
      permissions: agentMember.permissions, active: false,
    },
  });
  const after = await f.request("/api/rooms/commons/work-claims-read", { token: accessToken });
  assert.equal(after.status, 403, "grant is dead in the room once its agent member is removed");
  // The human's own access is exactly as before.
  const human = memberOf(f.store, "commons", "owner");
  assert.ok(human.active);
  const humanRead = await f.request("/api/rooms/commons/work-claims-read", { token: f.ownerKey });
  assert.equal(humanRead.status, 200);
  const session = await f.request("/api/oauth/sessions", { headers: f.accountHeaders });
  assert.equal(session.status, 200, "the human's account session still authenticates");
});

test("whole-agent removal: the grant dies, the identity is revoked, the human's account and rooms are untouched", async t => {
  const f = await serve(t);
  const { accessToken } = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(accessToken);
  // Materialize the agent member in both rooms.
  assert.equal((await f.request("/api/rooms/commons/work-claims-read", { token: accessToken })).status, 200);
  assert.equal((await f.request("/api/rooms/annex/work-claims-read", { token: accessToken })).status, 200);
  const removed = f.store.oauthGrantAgents.remove({ accountId: "account-owner", clientId: "muse" });
  assert.equal(removed.identityId, grant.agentIdentityId);
  // The grant is dead at both doors in both rooms.
  assert.equal((await f.request("/api/rooms/commons/work-claims-read", { token: accessToken })).status, 401);
  assert.equal((await f.request("/api/rooms/annex/work-claims-read", { token: accessToken })).status, 401);
  // The agent member is deactivated everywhere and unlinked.
  for (const roomId of ["commons", "annex"]) {
    const agent = memberOf(f.store, roomId, grant.agentIdentityId);
    assert.equal(agent.active, false, `${roomId}: agent member deactivated`);
  }
  const identity = f.store.db.prepare("SELECT revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?")
    .get(grant.agentIdentityId);
  assert.ok(identity.revokedAt, "identity revoked");
  const binding = f.store.oauthGrantAgents.binding({ accountId: "account-owner", clientId: "muse" });
  assert.ok(binding.revokedAt, "binding revoked");
  // The human: account active, both memberships active, session alive.
  assert.equal(f.store.account("account-owner").active, true);
  assert.ok(memberOf(f.store, "commons", "owner").active);
  assert.ok(memberOf(f.store, "annex", "owner").active);
  assert.equal((await f.request("/api/oauth/sessions", { headers: f.accountHeaders })).status, 200);
  // Re-approval mints a FRESH agent; the removed one stays removed.
  const again = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant2 = f.provider.verifyAccessToken(again.accessToken);
  assert.notEqual(grant2.agentIdentityId, grant.agentIdentityId);
  assert.equal((await f.request("/api/rooms/commons/work-claims-read", { token: again.accessToken })).status, 200);
});

test("grant revocation kills the family; the agent identity and the human are untouched", async t => {
  const f = await serve(t);
  const pair = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(pair.accessToken);
  assert.equal((await f.request("/api/rooms/commons/work-claims-read", { token: pair.accessToken })).status, 200);
  const revoked = await f.request("/oauth/revoke", {
    method: "POST", data: { token: pair.refreshToken, client_id: "muse" },
  });
  assert.equal(revoked.status, 200);
  assert.equal(f.provider.verifyAccessToken(pair.accessToken), null);
  assert.equal((await f.request("/api/rooms/commons/work-claims-read", { token: pair.accessToken })).status, 401);
  // The binding and identity survive a grant revocation (revocation is
  // grant-side; the owned agent is removed only by agent removal).
  const binding = f.store.oauthGrantAgents.binding({ accountId: "account-owner", clientId: "muse" });
  assert.equal(binding.revokedAt, null);
  const identity = f.store.db.prepare("SELECT revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?")
    .get(grant.agentIdentityId);
  assert.equal(identity.revokedAt, null);
  assert.ok(memberOf(f.store, "commons", "owner").active);
});

test("an agent-principal token with no binding fails closed — it never falls back to the human", async t => {
  const f = await serve(t);
  const bare = createOAuthProvider({ db: f.store.db, clock: () => f.store.now() });
  bare.registerClient(CLIENTS[0]);
  const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
  const codeChallenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  const { code } = bare.issueCode({
    clientId: "muse", userId: "account-owner",
    redirectUri: CLIENTS[0].redirectUris[0], scopes: ALL_SCOPES, codeChallenge,
  });
  const { accessToken } = bare.exchangeCode({
    code, clientId: "muse", redirectUri: CLIENTS[0].redirectUris[0], codeVerifier: verifier,
  });
  const response = await f.request("/api/rooms/commons/work-claims-read", { token: accessToken });
  assert.equal(response.status, 401);
});

test("sessions view names the agent principal and distinguishes pull-only / connected / listening", async t => {
  const f = await serve(t);
  const pair = f.mint("muse", "account-owner", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(pair.accessToken);
  const sessions = async () => (await f.request("/api/oauth/sessions", { headers: f.accountHeaders })).body.sessions;
  const entry = list => list.find(item => item.clientId === "muse");
  let list = await sessions();
  assert.equal(entry(list).agent.identityId, grant.agentIdentityId);
  assert.equal(entry(list).agent.displayName, "John's Claude");
  assert.equal(entry(list).agent.receiving, "pull-only");
  // A fresh wakeable host observation: connected, not listening.
  f.store.agentHeartbeats.heartbeat({ agentId: grant.agentIdentityId, hostId: "host-1", mode: "wakeable" });
  list = await sessions();
  assert.equal(entry(list).agent.receiving, "connected");
  // A live listener lease: listening.
  f.store.agentHeartbeats.acquireListenerLease({ agentId: grant.agentIdentityId, listenerId: "listener-1" });
  list = await sessions();
  assert.equal(entry(list).agent.receiving, "listening");
});

test("admission rule: a grant whose owner lacks invite authority in the room is denied at the bind; the human is unaffected", async t => {
  const f = await serve(t);
  // Approval still mints plain's owned agent identity (approval is the
  // account's own act); admission to a room is the room's call.
  const { accessToken } = f.mint("muse", "account-plain", ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(accessToken);
  assert.ok(grant.agentIdentityId, "approval minted the owned agent identity");
  const res = await f.request("/api/rooms/commons/work-claims-read", { token: accessToken });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, "access_denied");
  assert.equal(res.body.error.message, "This account's member cannot admit its agent to this Room");
  // No agent member was admitted, and plain's human member is untouched.
  assert.equal(memberOf(f.store, "commons", grant.agentIdentityId), undefined);
  const plain = memberOf(f.store, "commons", "plain");
  assert.equal(plain.kind, "human");
  assert.ok(plain.active);
});

test("first-party Mac app client keeps the account principal (named carve-out)", async t => {
  const f = await serve(t);
  const tokens = await f.approveViaHttp(CLIENTS[1], ALL_SCOPES);
  const grant = f.provider.verifyAccessToken(tokens.access_token);
  assert.equal(grant.principal, "account");
  assert.equal(grant.agentIdentityId, null);
  // No agent identity is minted for the Mac app sign-in.
  assert.equal(f.store.oauthGrantAgents.binding({ accountId: "account-owner", clientId: "project-room-macos" }), null);
  // Its actions attribute to the human member, exactly as stage 1.
  const closed = await f.request("/api/rooms/commons/work-claims/claim-1/close", {
    method: "POST", token: tokens.access_token, data: {},
  });
  assert.equal(closed.status, 200);
  const claim = f.store.workClaims.get("commons", "claim-1");
  assert.equal(claim.history[claim.history.length - 1].agentId, "owner");
});
