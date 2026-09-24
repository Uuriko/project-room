// RC-2026-09-24-210 — identity-holder proof-of-possession.
// HTTP integration tests for POST /api/identities/{identityId}/link-code:
// minting requires the identity's OWN pri_ secret (cross-identity minting
// is 403, scoped rak_ keys are 403, wrong/missing secrets are 401,
// unknown identities are 404), and the response hands the raw code back
// exactly once with a 10-minute expiry.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { API_KEY_PREFIX } from "../server/agent-api-keys.mjs";

const startServer = async (t, f) => {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
};

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body ?? {}),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const jsonOf = async res => ({ status: res.status, body: await res.json() });

test("mint with the holder's own secret returns 201 with a 128-bit code and 10-minute expiry", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Link-code agent");
  const { status, body } = await jsonOf(await post(origin, `/api/identities/${agent.identityId}/link-code`, null, agent.secret));
  assert.equal(status, 201);
  assert.equal(body.identityId, agent.identityId);
  assert.match(body.linkCode, /^[A-Za-z0-9_-]{22}$/, "128 bits, base64url");
  assert.equal(body.expiresAt - Date.now() < 10 * 60 * 1000 + 5000 && body.expiresAt - Date.now() > 9 * 60 * 1000, true);
  // The minted code is exactly the one the enrollment path consumes.
  assert.doesNotThrow(() => f.store.identities.consumeLinkCode(agent.identityId, body.linkCode));
});

test("minting is the holder's consent: no auth, wrong secret, and revoked identity all fail", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Link-code agent");
  const path = `/api/identities/${agent.identityId}/link-code`;

  assert.equal((await post(origin, path)).status, 401, "no bearer");
  const wrong = await jsonOf(await post(origin, path, null, "pri_totallybogus"));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, "unauthenticated");

  // A sponsor's secret for a DIFFERENT identity cannot mint for this one.
  const sponsor = f.store.identities.create("Sponsor");
  const cross = await jsonOf(await post(origin, path, null, sponsor.secret));
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error.code, "cross_identity");

  // A revoked identity's secret can never mint again.
  f.store.identities.revoke(agent.identityId, agent.secret);
  const revoked = await jsonOf(await post(origin, path, null, agent.secret));
  assert.equal(revoked.status, 401);
});

test("scoped rak_ API keys can never mint a link code", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Link-code agent");
  const issued = f.store.agentPlugin.issueApiKey({ identityId: agent.identityId, scopes: ["rooms:read"] });
  const res = await jsonOf(await post(origin, `/api/identities/${agent.identityId}/link-code`, null, API_KEY_PREFIX + issued.secret));
  assert.equal(res.status, 403, "a scoped API key can never mint, even for its own identity");
  assert.equal(res.body.error.code, "insufficient_scope");
});

test("minting for an unknown identity is 403 cross_identity (no oracle), and the route is POST-only", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const holder = f.store.identities.create("Holder");
  const res = await jsonOf(await post(origin, "/api/identities/ai_doesnotexist000000000000000000000000000000/link-code", null, holder.secret));
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, "cross_identity");
  const getRes = await get(origin, "/api/identities/ai_doesnotexist000000000000000000000000000000/link-code", holder.secret);
  assert.equal(getRes.status, 404, "GET on the mint path is not routed");
});
