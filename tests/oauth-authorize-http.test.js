// QA-Auth 2026-09-19: HTTP tests for POST /oauth/authorize.
//
// The consent POST must validate the authorization request (client_id +
// redirect_uri against the registered clients) BEFORE acting on the
// decision. Before the fix, the deny/error paths 302-redirected to an
// unvalidated redirect_uri (open redirect) and a malformed redirect_uri
// threw an uncaught 500.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const CLIENT = { clientId: "muse-qa", name: "Muse QA", redirectUris: ["https://muse.ai/callback"] };

async function startServer(t) {
  const fixture = createAcceptanceFixture();
  const sent = [];
  const server = createRoomServer({
    store: fixture.store,
    magicLinkMailer: createMagicLinkMailer({ send: async payload => { sent.push(payload); } }),
    connectorClients: [CLIENT],
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, sent };
}

async function signedInSession(origin) {
  const sr = await fetch(`${origin}/api/account-session`);
  const slotView = await sr.json();
  const token = /account_session=([A-Za-z0-9_-]{43})/.exec(sr.headers.get("set-cookie") ?? "")[1];
  const post = (path, body, tok = token, csrf = slotView.csrf) => fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": "account_session=" + tok, "X-CSRF-Token": csrf, Origin: origin },
    body: JSON.stringify(body),
  });
  await post("/api/auth/magic/request", { email: "oauth-qa@example.com" });
  return { token, csrf: slotView.csrf, revision: slotView.sessionRevision };
}

async function magicLogin(t, origin, sent) {
  const { token, csrf, revision } = await signedInSession(origin);
  const code = sent.at(-1).code;
  const res = await fetch(`${origin}/api/auth/magic/consume`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": "account_session=" + token, "X-CSRF-Token": csrf, Origin: origin },
    body: JSON.stringify({ email: "oauth-qa@example.com", code, sessionToken: token, sessionRevision: revision }),
  });
  assert.equal(res.status, 201);
  const fresh = /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") ?? "")[1];
  const view = await res.json();
  return { token: fresh, csrf: view.csrf };
}

const authorizeBody = (overrides = {}) => ({
  decision: "allow",
  client_id: CLIENT.clientId,
  redirect_uri: CLIENT.redirectUris[0],
  scope: "rooms:read chat:read",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: "xyz",
  ...overrides,
});

const postAuthorize = (origin, session, body) => fetch(`${origin}/oauth/authorize`, {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/json", "Cookie": "account_session=" + session.token, "X-CSRF-Token": session.csrf, Origin: origin },
  body: JSON.stringify(body),
});

test("allow -> 302 with code to the registered redirect URI, then token exchange", async t => {
  const { origin, sent } = await startServer(t);
  const session = await magicLogin(t, origin, sent);
  const res = await postAuthorize(origin, session, authorizeBody());
  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.ok(location.startsWith("https://muse.ai/callback?"), location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  assert.equal(new URL(location).searchParams.get("state"), "xyz");
  const tokenRes = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], code_verifier: VERIFIER }),
  });
  assert.equal(tokenRes.status, 200);
  const tokens = await tokenRes.json();
  assert.ok(tokens.access_token.startsWith("oat_"));
  assert.equal(tokens.scope, "rooms:read chat:read");
});

test("deny -> 302 to the REGISTERED redirect URI with access_denied", async t => {
  const { origin, sent } = await startServer(t);
  const session = await magicLogin(t, origin, sent);
  const res = await postAuthorize(origin, session, authorizeBody({ decision: "deny" }));
  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.ok(location.startsWith("https://muse.ai/callback?"), location);
  assert.equal(new URL(location).searchParams.get("error"), "access_denied");
});

test("deny with unregistered redirect_uri -> 400, no redirect to attacker URL", async t => {
  const { origin, sent } = await startServer(t);
  const session = await magicLogin(t, origin, sent);
  const res = await postAuthorize(origin, session, authorizeBody({ decision: "deny", redirect_uri: "https://evil.example/x" }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_request");
});

test("allow with unregistered redirect_uri -> 400, no code issued to attacker URL", async t => {
  const { origin, sent } = await startServer(t);
  const session = await magicLogin(t, origin, sent);
  const res = await postAuthorize(origin, session, authorizeBody({ redirect_uri: "https://evil.example/x" }));
  assert.equal(res.status, 400);
});

test("malformed redirect_uri -> 400 JSON, not an uncaught 500", async t => {
  const { origin, sent } = await startServer(t);
  const session = await magicLogin(t, origin, sent);
  const res = await postAuthorize(origin, session, authorizeBody({ decision: "deny", redirect_uri: "not a url" }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_request");
});

test("missing code_challenge_method -> 400", async t => {
  const { origin, sent } = await startServer(t);
  const session = await magicLogin(t, origin, sent);
  const body = authorizeBody();
  delete body.code_challenge_method;
  const res = await postAuthorize(origin, session, body);
  assert.equal(res.status, 400);
});

test("authenticated GET renders the consent screen (not a login redirect)", async t => {
  const { origin, sent } = await startServer(t);
  const session = await magicLogin(t, origin, sent);
  const params = new URLSearchParams({ client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], scope: "rooms:read chat:write", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s1" });
  const res = await fetch(`${origin}/oauth/authorize?${params}`, {
    redirect: "manual",
    headers: { "Cookie": "account_session=" + session.token },
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Connect Muse QA to Project Room?"));
  assert.ok(html.includes("Post messages"), "write scope is disclosed");
  assert.ok(html.includes('name="code_challenge_method" value="S256"'), "form carries the S256 method for the POST");
});

test("unauthenticated consent POST -> 401 before any request validation", async t => {
  const { origin } = await startServer(t);
  const res = await fetch(`${origin}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(authorizeBody()),
  });
  assert.equal(res.status, 401);
});
