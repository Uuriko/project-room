// RC-2026-09-19-075 (QAX-008): Google OAuth signup must thread the
// provider-verified email through the flow — like the GitHub flow does —
// so linkOAuthMethod + linkMagicMethod land on the same email and a later
// magic-link sign-in resolves to the same account instead of forking a
// second one. Unit tests for verifyIdToken's email claim handling plus
// HTTP integration tests proving the no-fork property end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { GoogleSignIn, GOOGLE_ISSUER, GOOGLE_START_PATH, GOOGLE_CALLBACK_PATH } from "../server/google-oauth.mjs";

const clientId = "1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com";
const clientSecret = "GOCSPX-fixture-secret-never-real";
const sub = "123456789012345678901";
const redirectUri = "https://room.example" + GOOGLE_CALLBACK_PATH;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = keys.publicKey.export({ format: "jwk" });
jwk.kid = "google-email-kid";
jwk.alg = "RS256";
jwk.use = "sig";

const jwksFetch = async url => {
  if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
  return new Response("missing", { status: 404 });
};

function idToken(extraClaims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: GOOGLE_ISSUER, sub, aud: clientId, iat: now, exp: now + 600, ...extraClaims
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}

const signIn = () => new GoogleSignIn({ clientId, clientSecret, redirectUri, fetchImpl: jwksFetch });

test("verifyIdToken returns the email when Google attests email_verified=true", async () => {
  const claims = await signIn().verifyIdToken(idToken({ email: "human@example.com", email_verified: true }));
  assert.equal(claims.sub, sub);
  assert.equal(claims.iss, GOOGLE_ISSUER);
  assert.equal(claims.email, "human@example.com");
});

test("verifyIdToken returns null email when email_verified is false or missing", async () => {
  const unverified = await signIn().verifyIdToken(idToken({ email: "human@example.com", email_verified: false }));
  assert.equal(unverified.email, null);
  const missing = await signIn().verifyIdToken(idToken());
  assert.equal(missing.email, null);
});

test("verifyIdToken ignores non-string or oversized email claims", async () => {
  const nonString = await signIn().verifyIdToken(idToken({ email: 42, email_verified: true }));
  assert.equal(nonString.email, null);
  const huge = await signIn().verifyIdToken(idToken({ email: `${"a".repeat(300)}@example.com`, email_verified: true }));
  assert.equal(huge.email, null);
});

test("verifyIdToken passes the attested email through un-normalized (the HTTP layer normalizes)", async () => {
  const claims = await signIn().verifyIdToken(idToken({ email: "Human@Example.COM", email_verified: true }));
  assert.equal(claims.email, "Human@Example.COM");
});

// --- HTTP integration: the no-fork property ---

function googleFetch(extraClaims) {
  return async url => {
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ id_token: idToken(extraClaims), scope: "openid email profile" });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    return new Response("missing", { status: 404 });
  };
}

async function startServer(t, f, extraClaims) {
  const server = createRoomServer({ store: f.store,
    googleAuth: { clientId, clientSecret, fetchImpl: googleFetch(extraClaims) } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const accountCookie = res => {
  const match = /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") || "");
  return match?.[1] ?? null;
};

async function completeFlow(origin) {
  const start = await fetch(origin + GOOGLE_START_PATH, { redirect: "manual" });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  const slotCookie = accountCookie(start);
  assert.ok(slotCookie);
  const callback = await fetch(
    `${origin}${GOOGLE_CALLBACK_PATH}?state=${authorize.searchParams.get("state")}&code=code-email`,
    { redirect: "manual", headers: { Cookie: `account_session=${slotCookie}` } });
  assert.equal(callback.status, 200);
  return { slotToken: accountCookie(callback) };
}

test("Google signup with a verified email links oauth + magic methods on the same email", async t => {
  const f = createAcceptanceFixture();
  const email = "forked-human@example.com";
  const origin = await startServer(t, f, { email, email_verified: true });
  const { slotToken } = await completeFlow(origin);
  const session = f.store.authenticateAccountSession(slotToken);
  const accountId = session.account.id;
  assert.equal(accountId, `google:${sub}`, "the account row stays keyed on the Google subject");
  const methods = f.store.accountLogins.listMethods(accountId);
  const oauth = methods.find(m => m.type === "oauth" && m.provider === "google");
  assert.ok(oauth, "expected a linked Google OAuth method");
  assert.equal(oauth.email, email);
  assert.ok(methods.some(m => m.type === "magic" && m.email === email),
    "the verified email also gets a magic-link method, like the GitHub flow");
  // The no-fork property: a later magic-link sign-in to the same email
  // resolves to this account instead of provisioning a second one.
  assert.equal(f.store.accountLogins.findAccountByVerifiedEmail(email), accountId);
});

test("Google signup without a verified email provisions subject-only (no magic method)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { email: "untrusted@example.com", email_verified: false });
  const { slotToken } = await completeFlow(origin);
  const session = f.store.authenticateAccountSession(slotToken);
  const methods = f.store.accountLogins.listMethods(session.account.id);
  assert.equal(methods.length, 1, "oauth only: no magic-link method without a verified email");
  assert.equal(methods[0].type, "oauth");
  assert.equal(methods[0].email, null);
});

test("Google sign-in to an email that already has a magic method lands on that account", async t => {
  const f = createAcceptanceFixture();
  const email = "existing-human@example.com";
  const emailAccountId = "email:google-075";
  f.store.createAccount(emailAccountId, "test");
  f.store.accountLogins.linkMagicMethod(emailAccountId, { email });
  const origin = await startServer(t, f, { email, email_verified: true });
  const { slotToken } = await completeFlow(origin);
  const session = f.store.authenticateAccountSession(slotToken);
  assert.equal(session.account.id, emailAccountId, "no new google:<sub> account is forked");
  const oauth = f.store.accountLogins.listMethods(emailAccountId).find(m => m.type === "oauth");
  assert.ok(oauth, "the Google subject is linked onto the existing account");
  assert.equal(oauth.provider, "google");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM accounts WHERE id=?").get(`google:${sub}`).n, 0);
});
