// Characterization tests for the AGENT-DOOR-AUTH program, Lane A.
//
// These tests pin CURRENT (pre-stage-1) auth behaviour at base cef1c0964.
// They are not aspirations: every assertion below was observed against the
// unmodified server. Later lanes change some of this behaviour deliberately
// (oat_ acceptance, scope mapping, and — in stage 3 — the MCP 401 challenge);
// when they do, the corresponding pin here is expected to be updated in the
// same PR that changes the behaviour.
//
// Pinned today:
// - server/http.mjs bearer() has NO oat_ alternative: a well-formed OAuth
//   access token (oat_ + 43 base64url chars), whether freshly minted by
//   server/oauth-provider.mjs or fabricated, is rejected at the format gate
//   with 401 unauthenticated / "Invalid Authorization header" — it never
//   reaches store.authenticate on room routes, the stream route, or
//   /api/session in room mode.
// - /api/session in account mode (a ?room= parameter selects it) rejects ANY
//   Authorization header with 403 access_denied before the bearer is parsed.
// - REST failure shapes: 401 unauthenticated (distinct messages for the
//   format gate vs unknown room key vs unknown identity vs unknown rak_),
//   403 access_denied for a non-member account session, 403
//   insufficient_scope for an api-key missing the route's scope.
// - /mcp: anonymous initialize + tools/list are public; an identity secret
//   reaches the room profile; an oat_ bearer gets the -32001
//   MCP_AUTH_REQUIRED error and a WWW-Authenticate header of exactly
//   Bearer realm="project-room", charset="UTF-8" — with NO
//   resource_metadata parameter (stage 3 changes this deliberately).
// - The OAuth provider island verifies its own tokens, but no resource-side
//   path accepts them (the REST and MCP pins above cover this).
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
import { EVENT_TYPES as T } from "../src/events.js";

const WWW_AUTHENTICATE_TODAY = 'Bearer realm="project-room", charset="UTF-8"';
const ANON_MCP_TOOLS = [
  "room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet",
  "public_work_recommend", "public_work_read_task", "room_identity_mint",
];

// Mint a real OAuth access token from a standalone provider instance,
// following tests/oauth-provider.test.js. The room server under test has
// its own provider with no such grant — the token is a genuine oat_ token
// string, and today nothing on the resource side can accept it.
function mintOat(scopes = ["rooms:read", "chat:read"]) {
  const provider = createOAuthProvider({ clock: () => 1_000_000 });
  provider.registerClient({
    clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"],
  });
  const verifier = "v-".padEnd(43, "d");
  const codeChallenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  const { code } = provider.issueCode({
    clientId: "muse", userId: "account-owner",
    redirectUri: "https://muse.ai/oauth/callback", scopes, codeChallenge,
  });
  const { accessToken } = provider.exchangeCode({
    code, clientId: "muse", redirectUri: "https://muse.ai/oauth/callback", codeVerifier: verifier,
  });
  assert.match(accessToken, /^oat_[A-Za-z0-9_-]{43}$/);
  return accessToken;
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-door-auth-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  store.createAccount("account-other");
  const ownerKey = store.issueAccessKey("commons", "owner", 7 * 86400000, "account-owner");
  const identity = store.identities.create("Door Agent");
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId: "agent", displayName: "Door Agent", permissions: [],
  });
  const agentKey = store.issueAccessKey("commons", "agent");
  const rak = scopes => "rak_" + store.agentPlugin.issueApiKey({ identityId: identity.identityId, scopes }).secret;
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = "GET", token, headers = {}, data } = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body, headers: response.headers };
  };
  const rpc = async (method, params, token) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body, headers: response.headers };
  };
  // Account-session login through the real HTTP flow (diagnostics.test.js
  // pattern): anonymous slot -> account access key -> rotated cookie.
  const loginAccount = async accountAccessKey => {
    const boot = await fetch(`${origin}/api/account-session`);
    const anonCookie = boot.headers.get("set-cookie").split(";", 1)[0];
    const bootBody = await boot.json();
    const res = await fetch(`${origin}/api/account-session`, {
      method: "POST",
      headers: { Cookie: anonCookie, Origin: origin, "X-CSRF-Token": bootBody.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ accountAccessKey, expectedSessionRevision: bootBody.sessionRevision }),
    });
    assert.equal(res.status, 201);
    const cookie = res.headers.get("set-cookie").split(";", 1)[0];
    const session = await res.json();
    return {
      cookie, token: cookie.split("=")[1], session,
      headers: { Cookie: cookie, "X-Project-Room-Auth": "account", "X-Session-Binding": session.sessionBinding },
    };
  };
  const seedUpdateForAgent = () => store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "please confirm the plan", toMemberId: "agent", requestKind: "reply" },
  });
  return { store, origin, request, rpc, loginAccount, seedUpdateForAgent, ownerKey, agentKey, identity, rak };
}

const READ = "/api/rooms/commons/updates";

test("REST bearer format gate: oat_ and other malformed shapes are 401 at the gate", async t => {
  const { request } = await serve(t);
  const minted = mintOat();
  const formatGate = [
    ["freshly minted oat_ token", minted],
    ["fabricated oat_ shape", "oat_" + "A".repeat(43)],
    ["oat_ too short (42)", "oat_" + "A".repeat(42)],
    ["oat_ too long (44)", "oat_" + "A".repeat(44)],
    ["oat_ bad charset", "oat_" + "A".repeat(42) + "!"],
    ["oar_ refresh-token shape", "oar_" + "A".repeat(43)],
    ["oac_ auth-code shape", "oac_" + "A".repeat(43)],
    ["unstructured garbage", "not-a-token"],
  ];
  for (const [label, token] of formatGate) {
    const res = await request(READ, { token });
    assert.equal(res.status, 401, label);
    assert.equal(res.body.error.code, "unauthenticated", label);
    assert.equal(res.body.error.message, "Invalid Authorization header", label);
    assert.equal(res.body.reason, "unauthenticated", label);
  }
  // Shapes that PASS the format gate fail later, with different messages —
  // the distinction is how a later lane can tell gate from lookup failures.
  const lookups = [
    ["unknown plain room key (43 chars)", "A".repeat(43), "Session or key expired or revoked"],
    ["unknown identity secret", "pri_" + "A".repeat(43), "Unknown identity or no access to this room"],
    ["unknown rak_ key", "rak_" + "A".repeat(43), "Unknown, revoked, or expired API key"],
  ];
  for (const [label, token, message] of lookups) {
    const res = await request(READ, { token });
    assert.equal(res.status, 401, label);
    assert.equal(res.body.error.code, "unauthenticated", label);
    assert.equal(res.body.error.message, message, label);
  }
  const anon = await request(READ);
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, "unauthenticated");
  assert.equal(anon.body.error.message, "No credential. Agents can self-mint an identity at POST /api/agent-identities.");
});

test("REST accepted credentials: room token, identity secret, and account-session cookie on read and write routes", async t => {
  const f = await serve(t);
  f.seedUpdateForAgent();

  const byRoomToken = await f.request(READ, { token: f.ownerKey });
  assert.equal(byRoomToken.status, 200);
  assert.equal(byRoomToken.body.viewerId, "owner");

  const byIdentity = await f.request(READ, { token: f.identity.secret });
  assert.equal(byIdentity.status, 200);
  assert.equal(byIdentity.body.viewerId, "agent");
  assert.equal(byIdentity.body.items.length, 1);

  const accountKey = f.store.issueAccountAccessKey("account-owner");
  const account = await f.loginAccount(accountKey);
  const byCookie = await f.request(READ, { headers: account.headers });
  assert.equal(byCookie.status, 200);
  assert.equal(byCookie.body.viewerId, "owner");
  assert.equal(byCookie.body.viewerSessionBinding, account.session.sessionBinding);

  // Write route in the same family: the agent's room token marks the
  // update done.
  const item = byIdentity.body.items[0];
  const written = await f.request(`${READ}/${item.id}/done`, {
    method: "POST", token: f.agentKey,
    data: { requestId: randomUUID(), expectedBasis: item.basisToken },
  });
  assert.equal(written.status, 200);
  assert.equal(written.body.duplicate, false);
  assert.equal(written.body.item.state, "handled");
});

test("REST api-key scope behaviour on the updates family: rak_ accepted with scope, 403 insufficient_scope without", async t => {
  const f = await serve(t);
  f.seedUpdateForAgent();
  const rakRW = f.rak(["rooms:read", "rooms:write"]);
  const rakWriteOnly = f.rak(["rooms:write"]);
  const rakReadOnly = f.rak(["rooms:read"]);

  const read = await f.request(READ, { token: rakRW });
  assert.equal(read.status, 200);
  assert.equal(read.body.viewerId, "agent");

  const deniedRead = await f.request(READ, { token: rakWriteOnly });
  assert.equal(deniedRead.status, 403);
  assert.equal(deniedRead.body.error.code, "insufficient_scope");
  assert.equal(deniedRead.body.error.message, "API key lacks the rooms:read scope");
  // Pinned as observed: the envelope reason for insufficient_scope is
  // "access_denied", not "insufficient_scope".
  assert.equal(deniedRead.body.reason, "access_denied");

  const item = read.body.items[0];
  const deniedWrite = await f.request(`${READ}/${item.id}/done`, {
    method: "POST", token: rakReadOnly,
    data: { requestId: randomUUID(), expectedBasis: item.basisToken },
  });
  assert.equal(deniedWrite.status, 403);
  assert.equal(deniedWrite.body.error.code, "insufficient_scope");
  assert.equal(deniedWrite.body.error.message, "API key lacks the rooms:write scope");

  const written = await f.request(`${READ}/${item.id}/done`, {
    method: "POST", token: rakRW,
    data: { requestId: randomUUID(), expectedBasis: item.basisToken },
  });
  assert.equal(written.status, 200);
  assert.equal(written.body.item.state, "handled");
});

test("REST 403 access_denied shapes: non-member account session, and an account session presented as a bearer", async t => {
  const f = await serve(t);

  const otherKey = f.store.issueAccountAccessKey("account-other");
  const other = await f.loginAccount(otherKey);
  const nonMember = await f.request(READ, { headers: other.headers });
  assert.equal(nonMember.status, 403);
  assert.equal(nonMember.body.error.code, "access_denied");
  assert.equal(nonMember.body.error.message, "This account has no membership in that Room");
  assert.equal(nonMember.body.reason, "access_denied");

  const ownerAcctKey = f.store.issueAccountAccessKey("account-owner");
  const account = await f.loginAccount(ownerAcctKey);
  // On /api/session the ?room= parameter selects account mode, and account
  // mode rejects ANY bearer header with 403 before bearer parsing.
  const asBearer = await f.request("/api/session?room=commons", { token: account.token });
  assert.equal(asBearer.status, 403);
  assert.equal(asBearer.body.error.code, "access_denied");
  assert.equal(asBearer.body.error.message, ["Account browser sessions do not use bearer", "authorization"].join(" "));
  // On a room route the same token presented as a bearer is instead a 401
  // (room mode authenticates it as a room credential and does not find it).
  const onRoomRoute = await f.request(READ, { token: account.token });
  assert.equal(onRoomRoute.status, 401);
  assert.equal(onRoomRoute.body.error.code, "unauthenticated");
  assert.equal(onRoomRoute.body.error.message, "Session or key expired or revoked");
});

test("direct-authenticate sites: stream and /api/session reject oat_ today", async t => {
  const f = await serve(t);
  const oat = mintOat();

  const stream = await f.request("/api/rooms/commons/stream", { token: oat });
  assert.equal(stream.status, 401);
  assert.equal(stream.body.error.code, "unauthenticated");
  assert.equal(stream.body.error.message, "Invalid Authorization header");

  const roomRoot = await f.request("/api/rooms/commons", { token: oat });
  assert.equal(roomRoot.status, 401);
  assert.equal(roomRoot.body.error.code, "unauthenticated");
  assert.equal(roomRoot.body.error.message, "Invalid Authorization header");

  const sessionRoomMode = await f.request("/api/session", { token: oat });
  assert.equal(sessionRoomMode.status, 401);
  assert.equal(sessionRoomMode.body.error.code, "unauthenticated");
  assert.equal(sessionRoomMode.body.error.message, "Invalid Authorization header");

  // With ?room= the route is in account mode: the 403 fires for any bearer,
  // oat_ included, before the format gate would have run.
  const sessionAccountMode = await f.request("/api/session?room=commons", { token: oat });
  assert.equal(sessionAccountMode.status, 403);
  assert.equal(sessionAccountMode.body.error.code, "access_denied");
  assert.equal(sessionAccountMode.body.error.message, ["Account browser sessions do not use bearer", "authorization"].join(" "));

  // The room-mode door itself works for a real room credential.
  const sessionOk = await f.request("/api/session", { token: f.ownerKey });
  assert.equal(sessionOk.status, 200);
  assert.equal(sessionOk.body.authMode, "room");
  assert.equal(sessionOk.body.credentialKind, "access");
  assert.equal(sessionOk.body.member.id, "owner");
});

test("/mcp: anonymous discovery is public, identity secret reaches the room profile, oat_ gets -32001 with the exact 401 challenge", async t => {
  const f = await serve(t);
  const oat = mintOat();

  const init = await f.rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "characterization", version: "1" },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, "2025-11-25");
  assert.equal(init.body.result.serverInfo.name, "project-room");

  const anonList = await f.rpc("tools/list");
  assert.equal(anonList.status, 200);
  assert.deepEqual(anonList.body.result.tools.map(tool => tool.name), ANON_MCP_TOOLS);

  const anonCall = await f.rpc("tools/call", { name: "room_check_access", arguments: {} });
  assert.equal(anonCall.status, 401);
  assert.equal(anonCall.body.error.code, -32001);
  assert.equal(anonCall.body.error.data.reason, "auth_required");
  assert.equal(anonCall.headers.get("www-authenticate"), WWW_AUTHENTICATE_TODAY);

  const identityList = await f.rpc("tools/list", undefined, f.identity.secret);
  assert.equal(identityList.status, 200);
  assert.equal(identityList.body.result.profile, "core");

  const access = await f.rpc("tools/call", { name: "room_check_access", arguments: { roomId: "commons" } }, f.identity.secret);
  assert.equal(access.status, 200);
  assert.equal(access.body.result.structuredContent.status, "credential_accepted");
  assert.equal(access.body.result.structuredContent.memberId, "agent");

  // A real minted oat_ token — and a fabricated one of the same shape —
  // are refused at the MCP door exactly like any other non-identity
  // credential: no data envelope on this path, and the challenge header
  // carries no resource_metadata parameter.
  for (const [label, token] of [["minted oat_", oat], ["fabricated oat_", "oat_" + "B".repeat(43)]]) {
    const listed = await f.rpc("tools/list", undefined, token);
    assert.equal(listed.status, 401, label);
    assert.equal(listed.body.error.code, -32001, label);
    assert.equal(listed.body.error.message, "Hosted room tools require a live identity or room token", label);
    assert.equal(listed.body.error.data, undefined, label);
    const challenge = listed.headers.get("www-authenticate");
    assert.equal(challenge, WWW_AUTHENTICATE_TODAY, label);
    assert.equal(challenge.includes("resource_metadata"), false, label);

    const called = await f.rpc("tools/call", { name: "room_check_access", arguments: { roomId: "commons" } }, token);
    assert.equal(called.status, 401, label);
    assert.equal(called.body.error.code, -32001, label);
    assert.equal(called.headers.get("www-authenticate"), WWW_AUTHENTICATE_TODAY, label);
  }
});

test("OAuth provider island: minted tokens verify with their grant scopes; expired and revoked tokens verify as null", () => {
  let now = 1_000_000;
  const provider = createOAuthProvider({ clock: () => now });
  provider.registerClient({
    clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"],
  });
  const mintPair = scopes => {
    const verifier = `v-${Math.random()}-`.padEnd(43, "x").slice(0, 43);
    const codeChallenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
    const { code } = provider.issueCode({
      clientId: "muse", userId: "account-owner",
      redirectUri: "https://muse.ai/oauth/callback", scopes, codeChallenge,
    });
    return provider.exchangeCode({
      code, clientId: "muse", redirectUri: "https://muse.ai/oauth/callback", codeVerifier: verifier,
    });
  };

  const pair = mintPair(["rooms:read", "chat:read"]);
  assert.match(pair.accessToken, /^oat_[A-Za-z0-9_-]{43}$/);
  const auth = provider.verifyAccessToken(pair.accessToken);
  assert.equal(auth.userId, "account-owner");
  assert.equal(auth.clientId, "muse");
  assert.deepEqual([...auth.scopes], ["rooms:read", "chat:read"]);
  assert.ok(Object.isFrozen(auth));
  assert.ok(provider.grants(pair.accessToken, "chat:read"));
  assert.ok(!provider.grants(pair.accessToken, "work:write"));
  assert.equal(provider.verifyAccessToken("oat_" + "Z".repeat(43)), null);

  // Revoked -> null.
  const second = mintPair(["rooms:read"]);
  assert.ok(provider.verifyAccessToken(second.accessToken));
  assert.equal(provider.revoke(second.accessToken), true);
  assert.equal(provider.verifyAccessToken(second.accessToken), null);

  // Expired (past the 1-hour access-token TTL) -> null.
  now += 61 * 60 * 1000;
  assert.equal(provider.verifyAccessToken(pair.accessToken), null);
});
