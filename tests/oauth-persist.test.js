// Regression test: OAuth PKCE state must survive Worker isolate eviction.
// The Google/GitHub start and callback requests can land on different
// isolates; the pending state lives in SQLite (not server memory) so the
// callback finds it even when the server instance is recreated.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { GOOGLE_ISSUER, GOOGLE_START_PATH, GOOGLE_CALLBACK_PATH } from "../server/google-oauth.mjs";

const clientId = "1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com";
const clientSecret = "GOCSPX-fixture-secret-never-real";
const sub = "123456789012345678901";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = keys.publicKey.export({ format: "jwk" });
jwk.kid = "google-evict-kid";
jwk.alg = "RS256";
jwk.use = "sig";

function idToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: GOOGLE_ISSUER, sub, aud: clientId, iat: now, exp: now + 600 })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}

function googleFetch() {
  return async url => {
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ id_token: idToken(), scope: "openid email profile" });
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    return new Response("missing", { status: 404 });
  };
}

async function startServer(f, googleAuth) {
  const server = createRoomServer({ store: f.store, googleAuth });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer({ server }, f) {
  server.closeStreams(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test("google OAuth callback succeeds after server instance recreation (isolate eviction)", async t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  const googleAuth = { clientId, clientSecret, fetchImpl: googleFetch() };

  // Instance 1: begin the flow (stores PKCE state)
  const inst1 = await startServer(f, googleAuth);
  t.after(() => stopServer(inst1, f));
  const start = await fetch(inst1.origin + GOOGLE_START_PATH, { redirect: "manual" });
  assert.equal(start.status, 302);
  const slotCookie = start.headers.get("set-cookie");
  assert.match(slotCookie, /account_session=/);
  const authorize = new URL(start.headers.get("location"));
  const state = authorize.searchParams.get("state");
  assert.ok(state);

  // Simulate isolate eviction: destroy instance 1, create instance 2 on the same store.
  await stopServer(inst1, f);
  const inst2 = await startServer(f, googleAuth);
  t.after(() => stopServer(inst2, f));

  // Instance 2: complete the callback with the state from instance 1.
  const callbackUrl = `${inst2.origin}${GOOGLE_CALLBACK_PATH}?state=${state}&code=fixture-code`;
  const callback = await fetch(callbackUrl, {
    redirect: "manual",
    headers: { Cookie: slotCookie.split(";")[0] },
  });
  // Success returns the same-origin HTML page (200), not /?google=error.
  assert.equal(callback.status, 200);
  const body = await callback.text();
  assert.match(body, /Opening Project Room/);
  assert.doesNotMatch(body, /google=error/);
  // Session cookie was set: the slot was upgraded.
  const setCookie = callback.headers.get("set-cookie") || "";
  assert.match(setCookie, /account_session=/);
});

test("github OAuth pending store survives recreation via persistent backend", async t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  const { createPendingStore } = await import("../server/github-oauth.mjs");
  const persistentStore = {
    create: entry => f.store.oauthPendingStateCreate(entry),
    consume: (provider, stateHash) => f.store.oauthPendingStateConsume(provider, stateHash),
    delete: (provider, stateHash) => f.store.oauthPendingStateDelete(provider, stateHash),
  };
  // Instance 1: create the pending entry.
  const store1 = createPendingStore({ now: () => f.store.now(), persistentStore });
  const { state } = store1.create({ sessionToken: "x".repeat(43), sessionRevision: 0 });
  assert.ok(state);
  // Instance 2 (new object, same DB): consume it.
  const store2 = createPendingStore({ now: () => f.store.now(), persistentStore });
  const consumed = store2.consume(state);
  assert.equal(consumed.sessionToken, "x".repeat(43));
  assert.equal(consumed.sessionRevision, 0);
  // Single-use: replay fails.
  assert.throws(() => store2.consume(state), /github_state_invalid/);
});
