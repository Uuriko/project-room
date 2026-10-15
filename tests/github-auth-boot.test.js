// Boot-path regression for #3528: GitHub sign-in 503'd in production
// because neither boot path ever built the githubAuth server option —
// tests injected it directly into createRoomServer, so the missing wiring
// was invisible. These tests go through the real boot path
// (env -> defaultServerArgs -> createRoomServer) instead.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { defaultServerArgs } from "../server/boot-options.mjs";
import { createRoomServer } from "../server/http.mjs";
import { githubConfig, GITHUB_START_PATH, GITHUB_CALLBACK_PATH } from "../server/github-oauth.mjs";

const clientId = "Iv1.fixtureclientid0000";
const clientSecret = "fixture-secret-never-real"; // secrets-allowlist (fixture value, not a credential)
const configuredEnv = { GITHUB_OAUTH_CLIENT_ID: clientId, GITHUB_OAUTH_CLIENT_SECRET: clientSecret };

// The real boot (server.mjs) configures the server with the origin it will
// listen on, and the HTTP layer rejects requests whose Host differs — so
// reserve a port, then boot on exactly that origin, like production does.
// 127.0.0.1 is the one host the HTTP layer accepts OAuth redirects over
// plain http for (local dev).
async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function startBootServer(t, env) {
  const port = await freePort();
  const bootOrigin = `http://127.0.0.1:${port}`;
  const f = createAcceptanceFixture();
  const args = defaultServerArgs({ store: f.store, env, origin: bootOrigin });
  const server = createRoomServer(args);
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return { f, args, bootOrigin, base: bootOrigin };
}

test("githubConfig: both secrets unset -> null (provider off, designed 503 stays)", () => {
  assert.equal(githubConfig({}, "https://room.example"), null);
  assert.equal(githubConfig({ GITHUB_OAUTH_CLIENT_ID: undefined, GITHUB_OAUTH_CLIENT_SECRET: undefined }, "https://room.example"), null);
});

test("githubConfig: partial or invalid config throws instead of half-wiring", () => {
  assert.throws(() => githubConfig({ GITHUB_OAUTH_CLIENT_ID: clientId }, "https://room.example"),
    /Invalid GitHub authentication configuration/);
  assert.throws(() => githubConfig({ GITHUB_OAUTH_CLIENT_SECRET: clientSecret }, "https://room.example"),
    /Invalid GitHub authentication configuration/);
  assert.throws(() => githubConfig(configuredEnv, "http://room.example"),
    /Invalid GitHub authentication configuration/, "plain http is only for 127.0.0.1");
  assert.throws(() => githubConfig({ ...configuredEnv, GITHUB_OAUTH_CLIENT_SECRET: "" }, "https://room.example"),
    /Invalid GitHub authentication configuration/);
});

test("githubConfig: valid env mints the callback redirect URI from the origin", () => {
  assert.deepEqual(githubConfig(configuredEnv, "https://room.example"),
    { clientId, clientSecret, redirectUri: "https://room.example" + GITHUB_CALLBACK_PATH });
  assert.deepEqual(githubConfig(configuredEnv, "http://127.0.0.1:8797"),
    { clientId, clientSecret, redirectUri: "http://127.0.0.1:8797" + GITHUB_CALLBACK_PATH });
});

test("boot path with GitHub env set: start route redirects to GitHub, never 503", async t => {
  const { f, args, bootOrigin, base } = await startBootServer(t, configuredEnv);
  assert.deepEqual(args.githubAuth,
    { clientId, clientSecret, redirectUri: bootOrigin + GITHUB_CALLBACK_PATH },
    "boot options carry the githubAuth the routes need");
  const slot = f.store.createAccountSessionSlot();
  const res = await fetch(`${base}${GITHUB_START_PATH}?sessionToken=${slot.token}`, { redirect: "manual" });
  assert.equal(res.status, 302);
  const authorize = new URL(res.headers.get("location"));
  assert.equal(authorize.origin, "https://github.com");
  assert.equal(authorize.pathname, "/login/oauth/authorize");
  assert.equal(authorize.searchParams.get("client_id"), clientId);
  assert.equal(authorize.searchParams.get("redirect_uri"), bootOrigin + GITHUB_CALLBACK_PATH);
});

test("boot path without GitHub env: githubAuth is null and the designed 503 remains", async t => {
  const { f, args, base } = await startBootServer(t, {});
  assert.equal(args.githubAuth, null);
  const slot = f.store.createAccountSessionSlot();
  const res = await fetch(`${base}${GITHUB_START_PATH}?sessionToken=${slot.token}`, { redirect: "manual" });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, "github_not_configured");
});
