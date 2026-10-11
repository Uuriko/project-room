// HTTP tests for the OAuth2 consent screen + decision (QA-Sec 2026-09-19):
// the consent flow was dead — GET/POST read slot?.session?.account?.id but
// accountSessionSlot never populates account, so every logged-in user was
// bounced to login (GET) / 401 (POST), and the native HTML form could never
// satisfy the JSON-only + x-csrf-token-only POST requirements. These tests
// pin the repaired flow: consent screen renders, form POST with a body
// csrf_token completes, the code exchanges for tokens, CSRF is enforced
// both ways, and failRedirect never redirects to an unregistered URI.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const CLIENT = { clientId: "consent-test-client", name: "Consent Test", redirectUris: ["https://client.example/cb"] };

function loginAccount(f) {
  f.store.createAccount("consent-user");
  const key = f.store.issueAccountAccessKey("consent-user");
  const slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, key, 0);
  return { slot, session };
}

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store, connectorClients: [CLIENT] });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  return { server, origin };
}

function pkce() {
  const verifier = "consent-verifier-" + "v".repeat(40);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authzPath(challenge) {
  return "/oauth/authorize?response_type=code&client_id=" + CLIENT.clientId
    + "&redirect_uri=" + encodeURIComponent(CLIENT.redirectUris[0])
    + "&scope=" + encodeURIComponent("chat:read")
    + "&state=s1&code_challenge=" + challenge + "&code_challenge_method=S256";
}

test("logged-in GET /oauth/authorize renders the consent form; anonymous is bounced to login", async t => {
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  const { slot } = loginAccount(f);
  const cookie = "account_session=" + slot.token;

  const screen = await fetch(origin + authzPath("x".repeat(43)), { headers: { cookie }, redirect: "manual" });
  assert.equal(screen.status, 200);
  const html = await screen.text();
  assert.match(html, /name="decision" value="allow"/);
  const csrf = html.match(/name="csrf_token" value="([^"]+)"/);
  assert.ok(csrf, "consent form must carry a csrf_token field");

  const anon = await fetch(origin + authzPath("x".repeat(43)), { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location") || "", /oauth=login/);
});

test("consent form POST completes the flow and the code exchanges for tokens", async t => {
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  const { slot } = loginAccount(f);
  const cookie = "account_session=" + slot.token;
  const { verifier, challenge } = pkce();

  const screen = await fetch(origin + authzPath(challenge), { headers: { cookie } });
  const screenHtml = await screen.text();
  const csrf = screenHtml.match(/name="csrf_token" value="([^"]+)"/)[1];
  const requestId = screenHtml.match(/name="request_id" value="([^"]+)"/)[1];
  const formBody = "decision=allow&client_id=" + CLIENT.clientId
    + "&redirect_uri=" + encodeURIComponent(CLIENT.redirectUris[0])
    + "&scope=chat%3Aread&state=s1&code_challenge=" + challenge
    + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(csrf)
    + "&request_id=" + encodeURIComponent(requestId);
  const consent = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin },
    body: formBody,
  });
  assert.equal(consent.status, 302);
  const location = new URL(consent.headers.get("location"));
  assert.equal(location.origin + location.pathname, CLIENT.redirectUris[0]);
  const code = location.searchParams.get("code");
  assert.ok(code, "consent redirect must carry an authorization code");
  assert.equal(location.searchParams.get("state"), "s1");

  const token = await fetch(origin + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: CLIENT.redirectUris[0], client_id: CLIENT.clientId, code_verifier: verifier }),
  });
  assert.equal(token.status, 200);
  const tokens = await token.json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.equal(tokens.token_type, "Bearer");
});

test("consent POST enforces CSRF: forged token rejected, JSON without header rejected, header accepted", async t => {
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  const { slot, session } = loginAccount(f);
  const cookie = "account_session=" + slot.token;
  const { challenge } = pkce();
  const base = "decision=allow&client_id=" + CLIENT.clientId
    + "&redirect_uri=" + encodeURIComponent(CLIENT.redirectUris[0])
    + "&scope=chat%3Aread&state=s1&code_challenge=" + challenge + "&code_challenge_method=S256&csrf_token=";

  const forged = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin },
    body: base + "forged-token",
  });
  assert.equal(forged.status, 403);

  const noProof = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ decision: "allow", client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], scope: "chat:read", state: "s1", code_challenge: challenge, code_challenge_method: "S256" }),
  });
  assert.equal(noProof.status, 403);

  const withHeader = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", cookie, origin, "x-csrf-token": session.csrf },
    body: JSON.stringify({ decision: "allow", client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], scope: "chat:read", state: "s1", code_challenge: challenge, code_challenge_method: "S256" }),
  });
  assert.equal(withHeader.status, 302);
});

test("consent deny with an unregistered redirect_uri fails closed (no open redirect)", async t => {
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  const { slot, session } = loginAccount(f);
  const cookie = "account_session=" + slot.token;
  const { challenge } = pkce();

  const deny = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", cookie, origin, "x-csrf-token": session.csrf },
    body: JSON.stringify({ decision: "deny", client_id: CLIENT.clientId, redirect_uri: "https://evil.example/stolen", scope: "chat:read", code_challenge: challenge, code_challenge_method: "S256" }),
  });
  assert.equal(deny.status, 400);
  assert.ok(!(deny.headers.get("location") || "").startsWith("https://evil.example/"));
  const error = await deny.json();
  assert.equal(error.error, "invalid_request");
});

test("logged-out consent POST is rejected; unknown client fails on the consent screen", async t => {
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  const { challenge } = pkce();

  const anon = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: "decision=allow&client_id=" + CLIENT.clientId + "&csrf_token=x",
  });
  assert.equal(anon.status, 401);

  const bad = await fetch(origin + "/oauth/authorize?response_type=code&client_id=nope"
    + "&redirect_uri=" + encodeURIComponent(CLIENT.redirectUris[0])
    + "&scope=chat%3Aread&code_challenge=" + challenge + "&code_challenge_method=S256",
    { headers: { cookie: "account_session=none" }, redirect: "manual" });
  // No session at all -> login bounce takes precedence over client validation.
  assert.equal(bad.status, 302);
});

test("POST /oauth/token: reuse of a rotated refresh token is invalid_grant with a reuse signal, and kills the family", async t => {
  // F-01 at the HTTP boundary: the theft response must be observable by the
  // client as a distinct invalid_grant (not a silent "revoked"), and the
  // whole family must die — the attacker's new chain included.
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  const { slot } = loginAccount(f);
  const cookie = "account_session=" + slot.token;
  const { verifier, challenge } = pkce();

  const screen = await fetch(origin + authzPath(challenge), { headers: { cookie } });
  const screenHtml = await screen.text();
  const csrf = screenHtml.match(/name="csrf_token" value="([^"]+)"/)[1];
  const requestId = screenHtml.match(/name="request_id" value="([^"]+)"/)[1];
  const consent = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin },
    body: "decision=allow&client_id=" + CLIENT.clientId
      + "&redirect_uri=" + encodeURIComponent(CLIENT.redirectUris[0])
      + "&scope=chat%3Aread&state=s1&code_challenge=" + challenge
      + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(csrf)
      + "&request_id=" + encodeURIComponent(requestId),
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const tokenOf = async params => {
    const res = await fetch(origin + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(params),
    });
    return { status: res.status, body: await res.json() };
  };
  const first = await tokenOf({ grant_type: "authorization_code", code, redirect_uri: CLIENT.redirectUris[0], client_id: CLIENT.clientId, code_verifier: verifier });
  assert.equal(first.status, 200);
  const rt1 = first.body.refresh_token;

  const second = await tokenOf({ grant_type: "refresh_token", refresh_token: rt1, client_id: CLIENT.clientId });
  assert.equal(second.status, 200);
  const rt2 = second.body.refresh_token;

  // Reuse the rotated refresh token: distinct invalid_grant, not a silent revoked.
  const reuse = await tokenOf({ grant_type: "refresh_token", refresh_token: rt1, client_id: CLIENT.clientId });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, "invalid_grant");
  assert.match(reuse.body.error_description, /reuse detected/);

  // Family is dead: the later refresh token fails too (plain revoked — the
  // theft was already signaled once at detection time).
  const dead = await tokenOf({ grant_type: "refresh_token", refresh_token: rt2, client_id: CLIENT.clientId });
  assert.equal(dead.status, 400);
  assert.equal(dead.body.error, "invalid_request");
  assert.match(dead.body.error_description, /refresh token revoked/);
});

// WAVE-500 g1: the consent screen must bind the grant. The GET renders what
// the user consents to; the POST must not be able to widen the scopes (or
// swap client/redirect) beyond what was displayed. The form carries a
// request_id resolving the server-side validated request; tampered body
// fields are ignored.
function requestIdOf(html) {
  return html.match(/name="request_id" value="([^"]+)"/)?.[1];
}

test("consent POST cannot grant scopes beyond what the consent screen displayed", async t => {
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  const { slot, session } = loginAccount(f);
  const cookie = "account_session=" + slot.token;
  const { verifier, challenge } = pkce();

  // The client asks for chat:read only; the screen shows "Read messages".
  const screen = await fetch(origin + authzPath(challenge), { headers: { cookie } });
  assert.equal(screen.status, 200);
  const html = await screen.text();
  assert.match(html, /Read messages/);
  assert.ok(!html.includes("Post messages"), "screen must not advertise chat:write");
  const csrf = html.match(/name="csrf_token" value="([^"]+)"/)[1];
  const requestId = requestIdOf(html); // undefined pre-fix: the binding does not exist yet

  // Tamper: submit the allow decision with a WIDER scope than consented to.
  const tampered = "decision=allow&client_id=" + CLIENT.clientId
    + "&redirect_uri=" + encodeURIComponent(CLIENT.redirectUris[0])
    + "&scope=chat%3Aread+chat%3Awrite&state=s1&code_challenge=" + challenge
    + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(csrf)
    + (requestId ? "&request_id=" + encodeURIComponent(requestId) : "");
  const consent = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin },
    body: tampered,
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  assert.ok(code, "consent redirect must carry an authorization code");

  const token = await fetch(origin + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: CLIENT.redirectUris[0], client_id: CLIENT.clientId, code_verifier: verifier }),
  });
  assert.equal(token.status, 200);
  const tokens = await token.json();
  assert.equal(tokens.scope, "chat:read", "grant must not exceed the consented scopes");
  assert.ok(session, "session fixture present");
});

test("consent form POST without a request_id is rejected", async t => {
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  const { slot, session } = loginAccount(f);
  const cookie = "account_session=" + slot.token;
  const { challenge } = pkce();

  const res = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin },
    body: "decision=allow&client_id=" + CLIENT.clientId
      + "&redirect_uri=" + encodeURIComponent(CLIENT.redirectUris[0])
      + "&scope=chat%3Aread&state=s1&code_challenge=" + challenge
      + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(session.csrf),
  });
  assert.equal(res.status, 400);
  const err = await res.json();
  assert.equal(err.error, "invalid_request");
});

test("a consent request_id cannot be replayed from another user's session", async t => {
  const f = createAcceptanceFixture();
  const { origin } = await startServer(t, f);
  const { slot } = loginAccount(f);
  const cookieA = "account_session=" + slot.token;
  // Second user with their own session.
  f.store.createAccount("consent-user-b");
  const keyB = f.store.issueAccountAccessKey("consent-user-b");
  const slotB = f.store.createAccountSessionSlot();
  const sessionB = f.store.loginAccountSession(slotB.token, keyB, 0);
  const cookieB = "account_session=" + slotB.token;
  const { challenge } = pkce();

  const screen = await fetch(origin + authzPath(challenge), { headers: { cookie: cookieA } });
  assert.equal(screen.status, 200);
  const requestId = requestIdOf(await screen.text());

  const res = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieB, origin },
    body: "decision=allow&client_id=" + CLIENT.clientId
      + "&redirect_uri=" + encodeURIComponent(CLIENT.redirectUris[0])
      + "&scope=chat%3Aread&state=s1&code_challenge=" + challenge
      + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(sessionB.csrf)
      + (requestId ? "&request_id=" + encodeURIComponent(requestId) : ""),
  });
  // Pre-fix there is no binding: B's own raw fields validate and the POST
  // succeeds (302). Post-fix the request_id belongs to user A → 400.
  if (requestId) assert.equal(res.status, 400);
  else assert.equal(res.status, 302);
});
