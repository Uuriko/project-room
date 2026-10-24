// CURE-4445-SCOPE: the two remainders of the seq-17115 re-test of
// CURE-4445-DCR, driven the way the finding author drove them.
//
// Pinned here:
// - authorize-time scope enforcement: scopes are stored on a dynamic
//   client's record (CURE-4445-DCR), and GET /oauth/authorize now
//   refuses a request beyond that stored set with invalid_scope, for
//   both the consent screen (GET) and the consent decision (POST — a
//   tampered scope field cannot widen past the screen). Within the
//   stored set the consent screen lists exactly that set, and the
//   code -> token -> refresh chain never carries more than was
//   granted. Provisioned clients (no stored set) keep the pre-cure
//   behaviour exactly.
// - Unicode-robust reserved-name matching: the normal form is NFKC +
//   stripped format/default-ignorable code points + a confusable fold,
//   applied to both sides, so the finding's three lookalike forms of a
//   provisioned name (fullwidth, zero-width-space-bearing, Cyrillic
//   homoglyph) refuse with invalid_client_metadata, a name made only
//   of ignorables refuses as empty metadata, and legitimately accented
//   fresh names still register.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createOAuthProvider, OAuthProviderError, OAUTH_SCOPES } from "../server/oauth-provider.mjs";

const PROVISIONED = Object.freeze({
  clientId: "chatgpt", name: "ChatGPT", redirectUris: ["https://chatgpt.com/oauth/callback"],
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-door-auth-scope-cure-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const server = createRoomServer({ store, connectorClients: [PROVISIONED] });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const accountKey = store.issueAccountAccessKey("account-owner");
  const slot = store.createAccountSessionSlot();
  store.loginAccountSession(slot.token, accountKey, 0);
  const accountCookie = `account_session=${slot.token}`;
  return { store, origin, accountCookie };
}

const registerClient = async (origin, metadata) => {
  const response = await fetch(origin + "/oauth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const pkce = () => {
  const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  return { verifier, challenge };
};

const authorizeGet = async (f, { clientId, redirectUri, scope }) => {
  const { challenge } = pkce();
  const query = "/oauth/authorize?response_type=code&client_id=" + clientId
    + "&redirect_uri=" + encodeURIComponent(redirectUri)
    + "&scope=" + encodeURIComponent(scope)
    + "&state=s7&code_challenge=" + challenge + "&code_challenge_method=S256";
  const response = await fetch(f.origin + query, { headers: { cookie: f.accountCookie } });
  return { status: response.status, body: await response.text(), challenge };
};

test("registration door: Unicode lookalikes of a provisioned name are refused", async t => {
  const f = await serve(t);
  const lookalikes = [
    ["fullwidth", "ＣｈａｔＧＰＴ"],
    ["trailing zero-width space", "ChatGPT​"],
    ["leading zero-width space", "​ChatGPT"],
    ["embedded zero-width space", "Chat​GPT"],
    ["Cyrillic capital Es", "СhatGPT"],
    ["Cyrillic small Es", "сhatgpt"],
    ["Greek small alpha", "ChαtGPT"],
  ];
  for (const [label, name] of lookalikes) {
    const res = await registerClient(f.origin, {
      client_name: name, redirect_uris: ["https://evil.example/cb"],
    });
    assert.equal(res.status, 400, `${label} must be refused`);
    assert.equal(res.body.error, "invalid_client_metadata", label);
  }
  // A name consisting only of ignorable characters is empty metadata.
  const hollow = await registerClient(f.origin, {
    client_name: "​﻿", redirect_uris: ["https://evil.example/cb"],
  });
  assert.equal(hollow.status, 400);
  assert.equal(hollow.body.error, "invalid_client_metadata");
});

test("registration door: legitimately accented fresh names still register", async t => {
  const f = await serve(t);
  for (const [label, name] of [
    ["precomposed accent", "Café Connect"],
    ["decomposed accent", "Café Outils"],
    ["umlaut", "Müller Werkzeug"],
  ]) {
    const res = await registerClient(f.origin, {
      client_name: name, redirect_uris: ["https://fresh.example/cb"],
    });
    assert.equal(res.status, 201, label);
    assert.match(res.body.client_id, /^dcr_/);
    assert.equal(res.body.client_name, name, "the stored name is the name as given");
  }
});

test("provider: the normal form applies to both sides of the comparison", () => {
  const provider = createOAuthProvider({ clock: () => 1_700_000_000_000 });
  // A provisioned name written in fullwidth is still reserved against
  // its plain-Latin lookalike: the provisioned side is normalised too.
  provider.registerClient({
    clientId: "claude-fw", name: "Ｃｌａｕｄｅ", redirectUris: ["https://claude.example/cb"],
  });
  provider.registerClient({ clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"] });
  for (const name of ["Claude", "Мuse"]) {
    let thrown = null;
    try { provider.registerDynamicClient({ name, redirectUris: ["https://evil.example/cb"] }); }
    catch (error) { thrown = error; }
    assert.ok(thrown instanceof OAuthProviderError, `name ${JSON.stringify(name)} throws`);
    assert.equal(thrown.code, "invalid_client_metadata", `name ${JSON.stringify(name)}`);
  }
  // Ignorable-only dynamic names refuse at provider level too.
  let thrown = null;
  try { provider.registerDynamicClient({ name: "​", redirectUris: ["https://evil.example/cb"] }); }
  catch (error) { thrown = error; }
  assert.ok(thrown instanceof OAuthProviderError);
  assert.equal(thrown.code, "invalid_client_metadata");
});

test("provider: authorize validation enforces the stored set for dynamic clients only", () => {
  const provider = createOAuthProvider({ clock: () => 1_700_000_000_000 });
  provider.registerClient({ clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"] });
  const minted = provider.registerDynamicClient({
    name: "Scoped Dyn", redirectUris: ["https://dyn.example/cb"], scopes: ["rooms:read"],
  });
  const { challenge } = pkce();
  // Over-ask: refused, with the scope error vocabulary.
  let thrown = null;
  try {
    provider.validateAuthorizationRequest({
      clientId: minted.clientId, redirectUri: "https://dyn.example/cb",
      scopes: ["rooms:read", "chat:write", "work:write"], codeChallenge: challenge,
    });
  } catch (error) { thrown = error; }
  assert.ok(thrown instanceof OAuthProviderError);
  assert.equal(thrown.code, "invalid_scope");
  // Within the stored set: validates, and carries exactly the request.
  const ok = provider.validateAuthorizationRequest({
    clientId: minted.clientId, redirectUri: "https://dyn.example/cb",
    scopes: ["rooms:read"], codeChallenge: challenge,
  });
  assert.deepEqual([...ok.scopes], ["rooms:read"]);
  // Provisioned client (no stored set): the full requestable set still
  // validates exactly as before the cure.
  const provisioned = provider.validateAuthorizationRequest({
    clientId: "muse", redirectUri: "https://muse.ai/oauth/callback",
    scopes: [...OAUTH_SCOPES], codeChallenge: challenge,
  });
  assert.deepEqual([...provisioned.scopes], [...OAUTH_SCOPES]);
});

test("authorize door: a dynamic client cannot exceed its registered scope set", async t => {
  const f = await serve(t);
  const registered = await registerClient(f.origin, {
    client_name: "Read Only Tool", redirect_uris: ["https://tool.example/cb"], scope: "rooms:read",
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.scope, "rooms:read");
  const clientId = registered.body.client_id;
  const redirectUri = "https://tool.example/cb";

  // Over-ask at the consent screen: refused invalid_scope, no screen.
  const over = await authorizeGet(f, {
    clientId, redirectUri, scope: "rooms:read chat:write work:write",
  });
  assert.equal(over.status, 400);
  assert.equal(JSON.parse(over.body).error, "invalid_scope");

  // Within the stored set: the consent screen lists exactly that set.
  const within = await authorizeGet(f, { clientId, redirectUri, scope: "rooms:read" });
  assert.equal(within.status, 200);
  assert.ok(within.body.includes("See your rooms"), "the stored scope is listed");
  for (const label of ["Read messages", "Post messages", "See work items", "Accept and complete work"]) {
    assert.ok(!within.body.includes(label), `consent screen must not list ${label}`);
  }

  // The consent decision cannot widen past the screen: a POST whose
  // scope field was tampered with is refused, and issues no code.
  const csrf = within.body.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  const tampered = await fetch(f.origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: f.accountCookie, origin: f.origin },
    body: "decision=allow&client_id=" + clientId
      + "&redirect_uri=" + encodeURIComponent(redirectUri)
      + "&scope=" + encodeURIComponent("rooms:read chat:write")
      + "&state=s7&code_challenge=" + within.challenge
      + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(csrf),
  });
  assert.equal(tampered.status, 400);
  assert.equal((await tampered.json()).error, "invalid_scope");

  // The honest flow at the stored set completes end to end, and neither
  // the exchange nor a refresh ever carries more than was granted.
  const { verifier, challenge } = pkce();
  const screenQuery = "/oauth/authorize?response_type=code&client_id=" + clientId
    + "&redirect_uri=" + encodeURIComponent(redirectUri)
    + "&scope=" + encodeURIComponent("rooms:read")
    + "&state=s7&code_challenge=" + challenge + "&code_challenge_method=S256";
  const screen = await fetch(f.origin + screenQuery, { headers: { cookie: f.accountCookie } });
  assert.equal(screen.status, 200);
  const screenHtml = await screen.text();
  const csrf2 = screenHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(csrf2);
  const consent = await fetch(f.origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: f.accountCookie, origin: f.origin },
    body: "decision=allow&client_id=" + clientId
      + "&redirect_uri=" + encodeURIComponent(redirectUri)
      + "&scope=" + encodeURIComponent("rooms:read")
      + "&state=s7&code_challenge=" + challenge
      + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(csrf2),
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  const tokenResponse = await fetch(f.origin + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code", code,
      redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.equal(tokens.scope, "rooms:read");
  const refreshed = await fetch(f.origin + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId,
    }),
  });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).scope, "rooms:read");
});

test("authorize door: provisioned client behaviour is unchanged", async t => {
  const f = await serve(t);
  // The full requestable set at the consent screen, all labels listed,
  // no dynamic-client block — exactly the pre-cure screen.
  const full = await authorizeGet(f, {
    clientId: PROVISIONED.clientId, redirectUri: PROVISIONED.redirectUris[0],
    scope: OAUTH_SCOPES.join(" "),
  });
  assert.equal(full.status, 200);
  for (const label of ["See your rooms", "Read messages", "Post messages", "See work items", "Accept and complete work"]) {
    assert.ok(full.body.includes(label), `provisioned screen lists ${label}`);
  }
  assert.ok(!full.body.includes("data-dynamic-client"));
  // A scope the server does not offer still refuses the pre-cure way.
  const unknown = await authorizeGet(f, {
    clientId: PROVISIONED.clientId, redirectUri: PROVISIONED.redirectUris[0], scope: "admin:all",
  });
  assert.equal(unknown.status, 400);
  assert.equal(JSON.parse(unknown.body).error, "invalid_request");
});
