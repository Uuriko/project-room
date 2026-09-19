// RC-2026-09-19-055 — identity-secret rotate/revoke.
// HTTP integration tests for POST /api/agent-identities/{id}/rotate and
// /revoke: rotation invalidates the old secret and the new one works,
// revoke kills every auth path (global agent surface, room routes, and the
// identity's scoped API keys), cross-identity management is rejected, and
// no response ever leaks a dead secret.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

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
const errorCode = async res => (await res.json()).error?.code;

// Link an identity into the fixture room so the room-scoped auth path
// (RoomStore#authenticate -> resolveIdentityAuth) is exercised too.
function linkToCommons(f, identityId) {
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  return f.store.identities.link(ownerKey, "commons", { identityId, permissions: ["accept_work"] });
}

test("rotate issues a new secret once; the old secret 401s on every pri_ auth path", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Rotating agent");
  linkToCommons(f, agent.identityId);
  const path = id => `/api/agent-identities/${id}/rotate`;

  const res = await post(origin, path(agent.identityId), null, agent.secret);
  assert.equal(res.status, 200);
  const rotated = await res.json();
  assert.equal(rotated.identityId, agent.identityId);
  assert.ok(typeof rotated.secret === "string" && rotated.secret.startsWith("pri_"));
  assert.notEqual(rotated.secret, agent.secret);
  assert.ok(typeof rotated.rotatedAt === "number");
  // The dead secret appears nowhere in the response.
  assert.ok(!JSON.stringify(rotated).includes(agent.secret));

  const dead = agent.secret;
  const fresh = rotated.secret;

  // The old secret fails the rotate auth itself.
  assert.equal(await errorCode(await post(origin, path(agent.identityId), null, dead)), "unauthenticated");

  // Room-scoped path: resolveIdentityAuth refuses the old secret, accepts the new.
  assert.equal((await get(origin, "/api/rooms/commons/events", dead)).status, 401);
  assert.equal((await get(origin, "/api/rooms/commons/events", fresh)).status, 200);

  // Global agent-surface path: resolveGlobalIdentitySecret refuses the old secret.
  assert.equal(await errorCode(await post(origin, "/api/agent-rooms",
    { roomId: "should-not-create", title: "x", purpose: "x", kind: "personal", displayName: "x" }, dead)), "unauthenticated");
  assert.notEqual(await errorCode(await post(origin, "/api/agent-rooms",
    { roomId: "rotate-probe-room", title: "x", purpose: "x", kind: "personal", displayName: "x" }, fresh)), "unauthenticated");

  // A second rotate with the dead secret stays dead; with the new one it works again.
  assert.equal(await errorCode(await post(origin, path(agent.identityId), null, dead)), "unauthenticated");
  const again = await post(origin, path(agent.identityId), null, fresh);
  assert.equal(again.status, 200);
  assert.notEqual((await again.json()).secret, fresh);
});

test("revoke kills every auth path and keeps the identity row for audit", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Revoked agent");
  linkToCommons(f, agent.identityId);
  const path = id => `/api/agent-identities/${id}/revoke`;

  const res = await post(origin, path(agent.identityId), null, agent.secret);
  assert.equal(res.status, 200);
  const revoked = await res.json();
  assert.deepEqual({ identityId: revoked.identityId, revoked: revoked.revoked, revokedApiKeys: revoked.revokedApiKeys },
    { identityId: agent.identityId, revoked: true, revokedApiKeys: 0 });
  assert.ok(typeof revoked.revokedAt === "number");
  assert.ok(!JSON.stringify(revoked).includes(agent.secret));

  const dead = agent.secret;
  assert.equal((await get(origin, "/api/rooms/commons/events", dead)).status, 401);
  assert.equal(await errorCode(await post(origin, "/api/agent-rooms",
    { roomId: "revoke-probe-room", title: "x", purpose: "x", kind: "personal", displayName: "x" }, dead)), "unauthenticated");

  // The identity row survives for audit; the secret is marked revoked.
  assert.equal(f.store.identities.secretRevoked(agent.identityId), true);
  assert.equal(f.store.identities.get(agent.identityId).identityId, agent.identityId);

  // Revoke is final: rotate with the dead secret cannot resurrect it.
  assert.equal(await errorCode(await post(origin, `/api/agent-identities/${agent.identityId}/rotate`, null, dead)), "unauthenticated");
  assert.throws(() => f.store.identities.rotate(agent.identityId, dead), err => err.code === "unauthenticated");

  // Revoking twice is rejected (the secret no longer authenticates at all).
  assert.equal(await errorCode(await post(origin, path(agent.identityId), null, dead)), "unauthenticated");
});

test("revoke also revokes the identity's scoped API keys", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Keyed agent");

  const issued = await post(origin, "/api/agent-keys",
    { scopes: ["webhooks:manage"], label: "revoke-probe" }, agent.secret);
  assert.equal(issued.status, 201);
  const credential = `rak_${(await issued.json()).secret}`;
  assert.equal((await get(origin, "/api/agent-webhooks", credential)).status, 200);

  const res = await post(origin, `/api/agent-identities/${agent.identityId}/revoke`, null, agent.secret);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).revokedApiKeys, 1);

  // The scoped key dies with the identity — the revoked identity cannot
  // keep operating through a key it minted earlier.
  assert.equal((await get(origin, "/api/agent-webhooks", credential)).status, 401);
});

test("rotate/revoke never cross identities", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const alice = f.store.identities.create("Alice agent");
  const bob = f.store.identities.create("Bob agent");

  // Alice's secret on Bob's rotate/revoke path: 403, Bob's secret untouched.
  for (const action of ["rotate", "revoke"]) {
    const path = `/api/agent-identities/${bob.identityId}/${action}`;
    assert.equal(await errorCode(await post(origin, path, null, alice.secret)), "cross_identity");
  }
  assert.equal(await errorCode(await post(origin, "/api/agent-identities/ai_nope/rotate", null, alice.secret)), "cross_identity");
  // Bob's secret is untouched: he can still rotate his own.
  assert.equal((await post(origin, `/api/agent-identities/${bob.identityId}/rotate`, null, bob.secret)).status, 200);
});

test("scoped API keys cannot manage identity secrets", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Scoped agent");

  const issued = await post(origin, "/api/agent-keys",
    { scopes: ["webhooks:manage"] }, agent.secret);
  assert.equal(issued.status, 201);
  const credential = `rak_${(await issued.json()).secret}`;

  const path = `/api/agent-identities/${agent.identityId}`;
  // ownerAuth rejects rak_ before the identity-match check: privilege
  // escalation through scoped credentials is impossible.
  assert.equal(await errorCode(await post(origin, `${path}/rotate`, null, credential)), "insufficient_scope");
  assert.equal(await errorCode(await post(origin, `${path}/revoke`, null, credential)), "insufficient_scope");
  // The identity secret still works — the key-management attempts changed nothing.
  assert.equal((await post(origin, `${path}/rotate`, null, agent.secret)).status, 200);
});

test("rotate/revoke require authentication", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Private agent");
  assert.equal((await post(origin, `/api/agent-identities/${agent.identityId}/rotate`)).status, 401);
  assert.equal((await post(origin, `/api/agent-identities/${agent.identityId}/revoke`)).status, 401);
  // A rotated-away secret format never authenticates (garbage pri_ token).
  assert.equal(await errorCode(await post(origin, `/api/agent-identities/${agent.identityId}/rotate`, null, "pri_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")), "unauthenticated");
});

test("revoked_at column is backfilled on pre-existing identity tables", async t => {
  const f = createAcceptanceFixture();
  // The fixture's AgentIdentities constructor ran ensureIdentitySecretSchema.
  const columns = f.store.db.prepare("PRAGMA table_info(agent_identities)").all().map(c => c.name);
  assert.ok(columns.includes("revoked_at"));
  // Idempotent: a second run does not throw.
  const { ensureIdentitySecretSchema } = await import("../server/agent-identities.mjs");
  assert.doesNotThrow(() => ensureIdentitySecretSchema(f.store.db));
  f.store.close();
});
