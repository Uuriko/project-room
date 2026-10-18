// P0-5 parity + zero-DO evidence for serving GET /api/auth/signin-options
// from the Worker (cloudflare/signin-options.mjs + the room.mjs branch)
// instead of the Durable Object.
//
// Parity baseline: the object's current answer, produced here by the REAL
// object handler (server/routes/signin-options.mjs handleSigninOptions)
// driven with the factories the object actually uses in production:
//   - githubAuth / googleAuth: githubConfig / googleConfig(env,
//     env.ROOM_ORIGIN) under the DO constructor's try/catch (a throw
//     disables the provider), in cloudflare/room.mjs;
//   - githubClient / googleClient: the http.mjs factories over that stored
//     config (github() revalidates its redirect URI and credentials and
//     throws on a bad shape; google() constructs GoogleSignIn);
//   - magicMailer: createMagicLinkMailer over magicLinkMailerFromEnv(env),
//     exactly as the DO constructor builds it;
//   - expectedOrigin: env.ROOM_ORIGIN, the origin the DO passes to
//     createRoomServer.
// The matrix enumerates every env combination those derivations branch on:
// each provider unset / partial (one half only) / invalid / valid, mail key
// unset / empty / set (with and without a custom from), all-valid, mixed
// valid+invalid, a passkey RP-ID override, and https vs loopback origins
// (127.0.0.1 and localhost differ between the github and google factories —
// that asymmetry is part of the baseline).
//
// Named divergences (unreachable from the Worker, so not approximated):
//   - http non-loopback origin: the object handler's passkey probe THROWS
//     422 passkey_origin_rejected (it is not wrapped in the probe helper),
//     so the object answers no body at all. The Worker can never see such
//     an origin — room.mjs refuses any request whose origin is not the
//     exact https ROOM_ORIGIN before routing — and the Worker helper folds
//     the throw to configured:false. Pinned by the divergence test below.
//   - A stored GitHub redirectUri hand-overridden after githubConfig
//     minted it: the http.mjs factory would throw and read as not
//     configured. Not an env combination (the constructor only stores what
//     githubConfig minted), so it is named here rather than reproduced.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, Response } from "miniflare";
import { fileURLToPath } from "node:url";
import { signinOptionsFromEnv, signinOptionsResponse } from "./signin-options.mjs";
import { handleSigninOptions } from "../server/routes/signin-options.mjs";
import { githubConfig, GITHUB_CALLBACK_PATH } from "../server/github-oauth.mjs";
import { googleConfig, GoogleSignIn, GOOGLE_CALLBACK_PATH } from "../server/google-oauth.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { magicLinkMailerFromEnv } from "../server/resend-mailer.mjs";

// The object's answer for one env + origin, via its real handler and the
// production factory wiring described above.
async function objectSigninOptions(env, origin) {
  let githubAuth = null;
  try { githubAuth = githubConfig(env, origin); } catch { /* DO constructor: provider disabled */ }
  let googleAuth = null;
  try { googleAuth = googleConfig(env, origin); } catch { /* DO constructor: provider disabled */ }
  const send = magicLinkMailerFromEnv(env);
  const magicMailer = send ? createMagicLinkMailer({ send, baseUrl: origin }) : createMagicLinkMailer();
  // server/http.mjs github(): revalidates the stored config on first use.
  const githubClient = () => {
    if (!githubAuth) return null;
    const { clientId, clientSecret } = githubAuth;
    let redirectUri = githubAuth.redirectUri || origin + GITHUB_CALLBACK_PATH;
    try {
      const parsed = new URL(redirectUri);
      if (parsed.pathname !== GITHUB_CALLBACK_PATH || parsed.search || parsed.hash
        || parsed.username || parsed.password
        || !(parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1"))) {
        throw new Error("bad redirect");
      }
      redirectUri = parsed.href;
    } catch { throw new Error("Invalid GitHub authentication configuration"); }
    if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) {
      throw new Error("Invalid GitHub authentication configuration");
    }
    return { clientId, clientSecret, redirectUri };
  };
  // server/http.mjs google(): constructs GoogleSignIn over the stored config.
  const googleClient = () => {
    if (!googleAuth) return null;
    return new GoogleSignIn({
      clientId: googleAuth.clientId, clientSecret: googleAuth.clientSecret,
      redirectUri: googleAuth.redirectUri || origin + GOOGLE_CALLBACK_PATH,
      fetchImpl: fetch, now: () => Date.now(),
      pendingStore: { create() {}, consume() {}, delete() {} },
    });
  };
  let captured = null;
  await handleSigninOptions({
    res: {},
    json: (res, status, value) => { captured = { status, value }; return value; },
    magicMailer,
    expectedOrigin: () => origin,
    githubClient,
    googleClient,
  });
  assert.ok(captured, "the object handler answered");
  assert.equal(captured.status, 200);
  return captured.value;
}

const ORIGIN = "https://room.example.test";
const GITHUB_VALID = { GITHUB_OAUTH_CLIENT_ID: "gh-client-id", GITHUB_OAUTH_CLIENT_SECRET: "gh-client-secret" };
const GOOGLE_VALID = { ROOM_GOOGLE_CLIENT_ID: "123456789-abc123def.apps.googleusercontent.com", ROOM_GOOGLE_CLIENT_SECRET: "google-client-secret" };
const MAIL_VALID = { RESEND_API_KEY: "re_test_key" };

const MATRIX = [
  ["nothing configured", {}],
  ["github valid only", { ...GITHUB_VALID }],
  ["github client id only (partial pair throws in githubConfig)", { GITHUB_OAUTH_CLIENT_ID: "gh-client-id" }],
  ["github client secret only (partial pair throws in githubConfig)", { GITHUB_OAUTH_CLIENT_SECRET: "gh-client-secret" }],
  ["github empty client id", { GITHUB_OAUTH_CLIENT_ID: "", GITHUB_OAUTH_CLIENT_SECRET: "gh-client-secret" }],
  ["github whitespace client secret", { GITHUB_OAUTH_CLIENT_ID: "gh-client-id", GITHUB_OAUTH_CLIENT_SECRET: "has space" }],
  ["google valid only", { ...GOOGLE_VALID }],
  ["google client id only (partial pair throws in googleConfig)", { ROOM_GOOGLE_CLIENT_ID: GOOGLE_VALID.ROOM_GOOGLE_CLIENT_ID }],
  ["google client secret only (partial pair throws in googleConfig)", { ROOM_GOOGLE_CLIENT_SECRET: "google-client-secret" }],
  ["google malformed client id", { ROOM_GOOGLE_CLIENT_ID: "not-a-google-client-id", ROOM_GOOGLE_CLIENT_SECRET: "google-client-secret" }],
  ["mail key only", { ...MAIL_VALID }],
  ["mail key empty string", { RESEND_API_KEY: "" }],
  ["mail key with custom from", { ...MAIL_VALID, ROOM_MAGIC_FROM: "Project Room <signin@example.test>" }],
  ["everything valid", { ...GITHUB_VALID, ...GOOGLE_VALID, ...MAIL_VALID }],
  ["everything valid with a passkey RP-ID override", { ...GITHUB_VALID, ...GOOGLE_VALID, ...MAIL_VALID, ROOM_PASSKEY_RP_ID: "example.test" }],
  ["github valid, google invalid, mail on", { ...GITHUB_VALID, ROOM_GOOGLE_CLIENT_ID: "bad", ROOM_GOOGLE_CLIENT_SECRET: "google-client-secret", ...MAIL_VALID }],
];

for (const [name, env] of MATRIX) {
  test(`parity at ${ORIGIN}: ${name}`, async () => {
    const expected = await objectSigninOptions(env, ORIGIN);
    assert.deepEqual(signinOptionsFromEnv(env, ORIGIN), expected);
  });
}

for (const origin of ["http://127.0.0.1:8787", "http://localhost:8787"]) {
  test(`parity at loopback origin ${origin}: everything valid`, async () => {
    const env = { ...GITHUB_VALID, ...GOOGLE_VALID, ...MAIL_VALID };
    const expected = await objectSigninOptions(env, origin);
    assert.deepEqual(signinOptionsFromEnv(env, origin), expected);
  });
}

test("named divergence: http non-loopback origin throws in the object, folds to false in the Worker", async () => {
  const env = { ...GITHUB_VALID, ...GOOGLE_VALID, ...MAIL_VALID };
  await assert.rejects(() => objectSigninOptions(env, "http://room.example.test"),
    error => error?.code === "passkey_origin_rejected");
  assert.equal(signinOptionsFromEnv(env, "http://room.example.test").providers.passkey.configured, false);
});

test("the Worker response carries the parity body as JSON with no-store", async () => {
  const env = { ...GITHUB_VALID, ...MAIL_VALID };
  const response = signinOptionsResponse(new Request(`${ORIGIN}/api/auth/signin-options`), env, ORIGIN);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), signinOptionsFromEnv(env, ORIGIN));
});

// Zero-DO evidence, integrated: the real Worker entry (via the counting
// fixture) answers the route — and its trailing-slash twin — without the
// Durable Object's fetch() ever running, while a POST still falls through
// to the object and gets its 405.
test("the Worker answers signin-options with zero Durable Object requests", async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./signin-options.test-fixture.mjs", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
  });
  const mf = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "SigninOptionsTestRoom", useSQLite: true } },
    bindings: { ROOM_ORIGIN: ORIGIN, ...GITHUB_VALID, ...MAIL_VALID },
    serviceBindings: {
      ASSETS: async () => new Response(null, { status: 404 }),
    },
  });
  const call = (path, { method = "GET" } = {}) => mf.dispatchFetch(ORIGIN + path, {
    method, headers: { Host: new URL(ORIGIN).host, "CF-Connecting-IP": "192.0.2.1" },
  });
  try {
    const stub = (await mf.getDurableObjectNamespace("ROOM")).getByName("invite-only-pilot");
    const fetches = () => stub.signinOptionsFetchCount();
    assert.equal(await fetches(), 0);
    const expected = await objectSigninOptions({ ...GITHUB_VALID, ...MAIL_VALID }, ORIGIN);
    for (const path of ["/api/auth/signin-options", "/api/auth/signin-options/"]) {
      const response = await call(path);
      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), expected, path);
    }
    assert.equal(await fetches(), 0, "the Worker answered both GETs without one Durable Object request");
    const post = await call("/api/auth/signin-options", { method: "POST" });
    assert.equal(post.status, 405, "non-GET still falls through to the object's route table");
    assert.equal(await fetches(), 1, "the POST reached the Durable Object exactly once");
  } finally {
    await mf.dispose();
  }
});
