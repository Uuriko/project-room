// D-4 (dormant P3): the public OAuth2 provider surface (discovery doc,
// /oauth/token, /oauth/revoke) was always-on even though nothing registers a
// connector client and no route authenticates an oat_ bearer token. The
// surface now only exists when connectorClients are configured - i.e. a real
// connector exists. The desktop app flow (/oauth/authorize, plus desktop-
// auth.mjs's internal exchange/verify/revoke calls) is unaffected.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const CLIENT = { clientId: "flag-test-client", name: "Flag Test", redirectUris: ["https://client.example/cb"] };

async function startServer(t, opts = {}) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, ...opts });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return "http://127.0.0.1:" + server.address().port;
}

test("with no connector clients, discovery, token, and revoke are 404", async t => {
  const origin = await startServer(t);
  const discovery = await fetch(origin + "/.well-known/oauth-authorization-server");
  assert.equal(discovery.status, 404);
  const token = await fetch(origin + "/oauth/token", { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(token.status, 404);
  const revoke = await fetch(origin + "/oauth/revoke", { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(revoke.status, 404);
});

test("with no connector clients, /oauth/authorize still serves the desktop flow", async t => {
  const origin = await startServer(t);
  const q = new URLSearchParams({ client_id: "project-room-macos", redirect_uri: "https://example.com/cb",
    scope: "openid", state: "s".repeat(43), code_challenge: "c".repeat(43), code_challenge_method: "S256" });
  const res = await fetch(origin + "/oauth/authorize?" + q);
  assert.notEqual(res.status, 404); // unknown-client rejection, not a missing route
});

test("with connector clients registered, the provider surface turns back on", async t => {
  const origin = await startServer(t, { connectorClients: [CLIENT] });
  const discovery = await fetch(origin + "/.well-known/oauth-authorization-server");
  assert.equal(discovery.status, 200);
  const token = await fetch(origin + "/oauth/token", { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" });
  assert.notEqual(token.status, 404);
});
