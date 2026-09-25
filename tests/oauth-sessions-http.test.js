// HTTP tests for F-02 session management: GET /api/oauth/sessions,
// POST /api/oauth/sessions/revoke-all, DELETE /api/oauth/sessions/:id,
// plus the refresh-token revocation cascade through POST /oauth/revoke.
//
// Owner-boundary contract: the consent screen promises "revoke access at any
// time" — these tests pin that revoking a refresh token (or a whole session,
// or every session) kills the family's access tokens immediately instead of
// leaving them valid to their 1-hour TTL, and that a caller can only ever
// see or kill their own sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const CLIENT = { clientId: "sessions-test-client", name: "Sessions Test", redirectUris: ["https://client.example/cb"] };
const CLIENT2 = { clientId: "sessions-test-client-2", name: "Sessions Test 2", redirectUris: ["https://client2.example/cb"] };
const UA = "f02-test-agent/1.0";

function loginAccount(f, accountId) {
  f.store.createAccount(accountId);
  const key = f.store.issueAccountAccessKey(accountId);
  const slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, key, 0);
  return { slot, session };
}

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store, connectorClients: [CLIENT, CLIENT2] });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// Full OAuth dance over HTTP: consent form -> code -> token exchange.
async function grantTokens(origin, login, client) {
  const cookie = "account_session=" + login.slot.token;
  const verifier = ("v-" + login.slot.token).slice(0, 43).padEnd(43, "f");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authz = "/oauth/authorize?response_type=code&client_id=" + client.clientId
    + "&redirect_uri=" + encodeURIComponent(client.redirectUris[0])
    + "&scope=" + encodeURIComponent("chat:read")
    + "&state=s1&code_challenge=" + challenge + "&code_challenge_method=S256";
  const screen = await fetch(origin + authz, { headers: { cookie } });
  assert.equal(screen.status, 200);
  const csrf = (await screen.text()).match(/name="csrf_token" value="([^"]+)"/)[1];
  const formBody = "decision=allow&client_id=" + client.clientId
    + "&redirect_uri=" + encodeURIComponent(client.redirectUris[0])
    + "&scope=chat%3Aread&state=s1&code_challenge=" + challenge
    + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(csrf);
  const consent = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin },
    body: formBody,
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  const tokenRes = await fetch(origin + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({
      grant_type: "authorization_code", code,
      client_id: client.clientId, redirect_uri: client.redirectUris[0],
      code_verifier: verifier,
    }),
  });
  assert.equal(tokenRes.status, 200);
  return tokenRes.json();
}

const readHeaders = login => ({
  cookie: "account_session=" + login.slot.token,
  "x-session-binding": login.session.sessionBinding,
});

const writeHeaders = (origin, login) => ({
  ...readHeaders(login),
  origin,
  "x-csrf-token": login.session.csrf,
  "content-type": "application/json",
});

async function listSessions(origin, login) {
  const res = await fetch(origin + "/api/oauth/sessions", { headers: readHeaders(login) });
  assert.equal(res.status, 200);
  return (await res.json()).sessions;
}

test("GET /api/oauth/sessions lists only the caller's sessions", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const alice = loginAccount(f, "sess-alice");
  const bob = loginAccount(f, "sess-bob");
  await grantTokens(origin, alice, CLIENT);
  await grantTokens(origin, bob, CLIENT);

  const aliceSessions = await listSessions(origin, alice);
  assert.equal(aliceSessions.length, 1);
  const [s] = aliceSessions;
  assert.equal(s.clientId, CLIENT.clientId);
  assert.deepEqual(s.scopes, ["chat:read"]);
  assert.equal(s.ip, "127.0.0.1");
  assert.equal(s.userAgent, UA);
  assert.ok(typeof s.id === "string" && s.id.length > 0);

  const bobSessions = await listSessions(origin, bob);
  assert.equal(bobSessions.length, 1);
  assert.notEqual(bobSessions[0].id, s.id);

  const anon = await fetch(origin + "/api/oauth/sessions");
  assert.equal(anon.status, 401);
});

test("POST /oauth/revoke with a refresh token kills the family's access tokens", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const alice = loginAccount(f, "sess-alice");
  const tokens = await grantTokens(origin, alice, CLIENT);
  assert.equal((await listSessions(origin, alice)).length, 1);

  const revoke = await fetch(origin + "/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tokens.refresh_token }),
  });
  assert.equal(revoke.status, 200);

  // The cascade is observable over HTTP: the session drops out of the
  // listing and the refresh grant is dead — no 1-hour access-token linger.
  assert.equal((await listSessions(origin, alice)).length, 0);
  const refresh = await fetch(origin + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLIENT.clientId,
    }),
  });
  assert.equal(refresh.status, 400);
});

test("POST /api/oauth/sessions/revoke-all kills every session across clients", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const alice = loginAccount(f, "sess-alice");
  const bob = loginAccount(f, "sess-bob");
  await grantTokens(origin, alice, CLIENT);
  await grantTokens(origin, alice, CLIENT2);
  await grantTokens(origin, bob, CLIENT);
  assert.equal((await listSessions(origin, alice)).length, 2);

  const res = await fetch(origin + "/api/oauth/sessions/revoke-all", {
    method: "POST", headers: writeHeaders(origin, alice), body: "{}",
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).revoked, 4); // 2 access + 2 refresh
  assert.equal((await listSessions(origin, alice)).length, 0);
  assert.equal((await listSessions(origin, bob)).length, 1); // bob untouched

  // CSRF is enforced on the write.
  const noCsrf = await fetch(origin + "/api/oauth/sessions/revoke-all", {
    method: "POST", headers: { ...readHeaders(bob), origin, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(noCsrf.status, 403);
});

test("DELETE /api/oauth/sessions/:id kills one session; cross-user and unknown ids 404", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const alice = loginAccount(f, "sess-alice");
  const bob = loginAccount(f, "sess-bob");
  await grantTokens(origin, alice, CLIENT);
  await grantTokens(origin, bob, CLIENT);
  const [aliceSession] = await listSessions(origin, alice);
  const [bobSession] = await listSessions(origin, bob);

  // Cross-user kill: 404, and bob's session is untouched.
  const cross = await fetch(origin + "/api/oauth/sessions/" + bobSession.id, {
    method: "DELETE", headers: writeHeaders(origin, alice),
  });
  assert.equal(cross.status, 404);
  assert.equal((await listSessions(origin, bob)).length, 1);

  // Unknown id: 404.
  const unknown = await fetch(origin + "/api/oauth/sessions/oarf_nope", {
    method: "DELETE", headers: writeHeaders(origin, alice),
  });
  assert.equal(unknown.status, 404);

  // Own session: killed, 2 tokens (access + refresh).
  const kill = await fetch(origin + "/api/oauth/sessions/" + aliceSession.id, {
    method: "DELETE", headers: writeHeaders(origin, alice),
  });
  assert.equal(kill.status, 200);
  assert.equal((await kill.json()).revoked, 2);
  assert.equal((await listSessions(origin, alice)).length, 0);
  assert.equal((await listSessions(origin, bob)).length, 1);
});
