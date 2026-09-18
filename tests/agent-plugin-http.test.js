// HTTP integration tests for the Lane D agent plug-in surface
// (RC-2026-09-18-010): the /api/agent-keys, /api/agent-directory,
// /api/agent-manifest and /api/agent-webhooks routes in server/http.mjs,
// wired to server/agent-plugin-store.mjs (SQLite persistence + ownership)
// with the pure modules untouched. No network calls, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { validatePluginManifest, WELL_KNOWN_PATH } from "../server/agent-plugin-manifest.mjs";

async function startServer(t, f, options = {}) {
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const del = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  method: "DELETE",
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

const errorCode = async res => (await res.json()).error?.code;

const fixtureCard = (overrides = {}) => ({
  name: "Fixture Agent",
  description: "A synthetic test agent for plug-in surface tests.",
  url: "https://agent.example.test",
  capabilities: ["chat"],
  skills: ["fixtures"],
  version: "1.0.0",
  ...overrides,
});

test("issue shows the secret once; list never shows it; storage is hash-only", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("key-agent");

  const issued = await post(origin, "/api/agent-keys", { scopes: ["rooms:read", "directory:publish"], label: "test key" }, identity.secret);
  assert.equal(issued.status, 201);
  const key = await issued.json();
  assert.match(key.keyId, /^rak_[A-Za-z0-9_-]+$/);
  assert.equal(key.identityId, identity.identityId);
  assert.deepEqual(key.scopes, ["rooms:read", "directory:publish"]);
  assert.equal(typeof key.secret, "string");
  assert.ok(key.secret.length >= 16, "secret carries real entropy");
  assert.ok(!("keyHash" in key), "hash never leaves the server");

  const listed = await get(origin, "/api/agent-keys", identity.secret);
  assert.equal(listed.status, 200);
  const listBody = await listed.json();
  assert.equal(listBody.keys.length, 1);
  assert.equal(listBody.keys[0].keyId, key.keyId);
  assert.ok(!("secret" in listBody.keys[0]), "list output has no secret");
  assert.ok(!JSON.stringify(listBody).includes(key.secret), "secret appears nowhere in the list response");

  const row = f.store.db.prepare("SELECT * FROM agent_api_keys WHERE key_id=?").get(key.keyId);
  assert.match(row.key_hash, /^[0-9a-f]{64}$/, "only the SHA-256 hash is stored");
  assert.ok(!JSON.stringify(row).includes(key.secret), "the secret is not persisted anywhere");
  assert.equal(row.identity_id, identity.identityId);
});

test("key routes require the pri_ identity secret and validate the body", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("key-agent-2");

  assert.equal((await post(origin, "/api/agent-keys", { scopes: ["x"] })).status, 401);
  assert.equal(await errorCode(await get(origin, "/api/agent-keys")), "unauthenticated");
  // A room access key is not an identity secret.
  const roomKey = f.store.issueAccessKey("commons", "owner");
  assert.equal((await post(origin, "/api/agent-keys", { scopes: ["x"] }, roomKey)).status, 401);

  assert.equal(await errorCode(await post(origin, "/api/agent-keys", { scopes: [] }, identity.secret)), "invalid_api_key_request");
  assert.equal(await errorCode(await post(origin, "/api/agent-keys", { scopes: ["x"], bogus: 1 }, identity.secret)), "invalid_api_key_request");
  assert.equal(await errorCode(await post(origin, "/api/agent-keys", { scopes: ["BAD SCOPE"] }, identity.secret)), "invalid_api_key");
  assert.equal(await errorCode(await post(origin, "/api/agent-keys", { scopes: ["x"], expiresAt: -5 }, identity.secret)), "invalid_api_key_request");
});

test("rotate replaces the secret (old stops working) and revoke ends the key", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("key-agent-3");
  const first = await (await post(origin, "/api/agent-keys", { scopes: ["rooms:read"] }, identity.secret)).json();
  const keyId = first.keyId;
  const issuedSecret = first.secret;

  const rotated = await post(origin, `/api/agent-keys/${keyId}/rotate`, {}, identity.secret);
  assert.equal(rotated.status, 200);
  const rotatedBody = await rotated.json();
  assert.ok(rotatedBody.secret && rotatedBody.secret !== issuedSecret, "rotation shows a new secret once");
  assert.ok(!("keyHash" in rotatedBody));

  assert.equal(f.store.agentPlugin.verifyApiKeySecret(issuedSecret), null, "the old secret no longer verifies");
  const verified = f.store.agentPlugin.verifyApiKeySecret(rotatedBody.secret);
  assert.equal(verified?.keyId, keyId, "the new secret verifies");
  assert.ok(verified.lastUsedAt !== null, "successful verify updates lastUsedAt");
  const row = f.store.db.prepare("SELECT last_used_at FROM agent_api_keys WHERE key_id=?").get(keyId);
  assert.ok(row.last_used_at !== null, "lastUsedAt is persisted");

  const revoked = await post(origin, `/api/agent-keys/${keyId}/revoke`, {}, identity.secret);
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).revoked, true);
  assert.equal(f.store.agentPlugin.verifyApiKeySecret(rotatedBody.secret), null, "revoked secret no longer verifies");
  assert.equal(await errorCode(await post(origin, `/api/agent-keys/${keyId}/rotate`, {}, identity.secret)), "invalid_api_key",
    "a revoked key cannot rotate");

  const listed = (await (await get(origin, "/api/agent-keys", identity.secret)).json()).keys;
  assert.equal(listed.find(k => k.keyId === keyId).revoked, true);
  assert.equal(await errorCode(await post(origin, "/api/agent-keys/rak_nope/rotate", {}, identity.secret)), "unknown_key");
});

test("one identity cannot rotate or revoke another identity's key", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const a = f.store.identities.create("key-owner");
  const b = f.store.identities.create("key-stranger");
  const keyId = (await (await post(origin, "/api/agent-keys", { scopes: ["rooms:read"] }, a.secret)).json()).keyId;
  assert.equal(await errorCode(await post(origin, `/api/agent-keys/${keyId}/rotate`, {}, b.secret)), "unknown_key");
  assert.equal(await errorCode(await post(origin, `/api/agent-keys/${keyId}/revoke`, {}, b.secret)), "unknown_key");
  // The key is untouched: the owner can still rotate it.
  assert.equal((await post(origin, `/api/agent-keys/${keyId}/rotate`, {}, a.secret)).status, 200);
});

test("publish/withdraw roundtrip with public visibility", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("dir-agent");

  const published = await post(origin, "/api/agent-directory/cards",
    { agentId: "fixture-agent", card: fixtureCard(), visibility: "public" }, identity.secret);
  assert.equal(published.status, 201);
  assert.equal((await published.json()).agentId, "fixture-agent");

  // The public document needs no auth.
  const doc = await (await get(origin, "/api/agent-directory")).json();
  assert.equal(doc.version, "1.0.0");
  assert.ok(doc.origin.startsWith("https://"), "document origin is https");
  const listed = doc.agents.find(a => a.agentId === "fixture-agent");
  assert.ok(listed, "published card appears in the public document");
  assert.ok(listed.cardUrl.endsWith("/api/agents/directory/fixture-agent"));

  const card = await get(origin, "/api/agents/directory/fixture-agent");
  assert.equal(card.status, 200);
  assert.equal((await card.json()).name, "Fixture Agent");

  const withdrawn = await del(origin, "/api/agent-directory/cards/fixture-agent", identity.secret);
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(await withdrawn.json(), { agentId: "fixture-agent", withdrawn: true });

  const after = await (await get(origin, "/api/agent-directory")).json();
  assert.equal(after.agents.find(a => a.agentId === "fixture-agent"), undefined);
  assert.equal((await get(origin, "/api/agents/directory/fixture-agent")).status, 404);
});

test("private cards stay out of the public document; ownership is enforced", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const owner = f.store.identities.create("dir-owner");
  const stranger = f.store.identities.create("dir-stranger");

  const published = await post(origin, "/api/agent-directory/cards",
    { agentId: "quiet-agent", card: fixtureCard({ name: "Quiet Agent" }), visibility: "private" }, owner.secret);
  assert.equal(published.status, 201);

  const doc = await (await get(origin, "/api/agent-directory")).json();
  assert.equal(doc.agents.find(a => a.agentId === "quiet-agent"), undefined, "private card is not listed publicly");
  assert.equal((await get(origin, "/api/agents/directory/quiet-agent")).status, 404, "private card has no public card URL");

  // Another identity cannot steal the agentId or withdraw the card.
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    { agentId: "quiet-agent", card: fixtureCard({ name: "Impostor" }) }, stranger.secret)), "card_owned_by_another_identity");
  assert.equal(await errorCode(await del(origin, "/api/agent-directory/cards/quiet-agent", stranger.secret)), "unknown_card");

  // Card validation errors surface as 422.
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    { agentId: "bad-agent", card: { name: "x" } }, owner.secret)), "invalid_directory");
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    { agentId: "BAD ID", card: fixtureCard() }, owner.secret)), "invalid_directory");

  // Owner republish updates the card.
  const republished = await post(origin, "/api/agent-directory/cards",
    { agentId: "quiet-agent", card: fixtureCard({ name: "Quiet Agent", version: "1.1.0" }), visibility: "public" }, owner.secret);
  assert.equal(republished.status, 201);
  assert.equal((await (await get(origin, "/api/agents/directory/quiet-agent")).json()).version, "1.1.0");
});

test("directory search filters query and capability", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("dir-search");
  await post(origin, "/api/agent-directory/cards",
    { agentId: "searchable-one", card: fixtureCard({ name: "Weather Bot", capabilities: ["weather"] }) }, identity.secret);
  await post(origin, "/api/agent-directory/cards",
    { agentId: "searchable-two", card: fixtureCard({ name: "Chat Bot", capabilities: ["chat"] }) }, identity.secret);

  const byName = await (await get(origin, "/api/agent-directory?q=weather")).json();
  assert.deepEqual(byName.agents.map(a => a.agentId), ["searchable-one"]);
  const byCap = await (await get(origin, "/api/agent-directory?capability=chat")).json();
  assert.deepEqual(byCap.agents.map(a => a.agentId), ["searchable-two"]);
});

test("subscribe/list/unsubscribe roundtrip; server secret shown once", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("hook-agent");

  assert.equal((await post(origin, "/api/agent-webhooks", { url: "https://hooks.example.test/agent", events: ["message.posted"] })).status, 401);

  const subscribed = await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/agent", events: ["message.posted", "work.completed"] }, identity.secret);
  assert.equal(subscribed.status, 201);
  const sub = await subscribed.json();
  assert.match(sub.subscriptionId, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(sub.agentId, identity.identityId);
  assert.deepEqual(sub.events, ["message.posted", "work.completed"]);
  assert.ok(typeof sub.secret === "string" && sub.secret.length >= 16, "server-generated signing secret shown once");
  assert.equal(sub.deliveries, 0);

  // A caller-supplied secret is never echoed back.
  const ownSecret = "caller-supplied-signing-secret-xyz";
  const supplied = await (await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/other", events: ["*"], secret: ownSecret }, identity.secret)).json();
  assert.ok(!("secret" in supplied), "caller-supplied secret is not echoed");

  const listed = await (await get(origin, "/api/agent-webhooks", identity.secret)).json();
  assert.equal(listed.subscriptions.length, 2);
  assert.ok(!JSON.stringify(listed).includes(sub.secret), "signing secrets never appear in listings");
  const row = f.store.db.prepare("SELECT secret FROM agent_webhook_subs WHERE subscription_id=?").get(sub.subscriptionId);
  assert.equal(row.secret, sub.secret, "the signing secret persists for delivery signing");

  const unsubscribed = await del(origin, `/api/agent-webhooks/${sub.subscriptionId}`, identity.secret);
  assert.equal(unsubscribed.status, 200);
  assert.deepEqual(await unsubscribed.json(), { subscriptionId: sub.subscriptionId, unsubscribed: true });
  assert.deepEqual((await (await get(origin, "/api/agent-webhooks", identity.secret)).json()).subscriptions.map(s => s.subscriptionId),
    [supplied.subscriptionId]);
});

test("webhook validation and cross-identity isolation", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const a = f.store.identities.create("hook-a");
  const b = f.store.identities.create("hook-b");

  assert.equal(await errorCode(await post(origin, "/api/agent-webhooks",
    { url: "http://hooks.example.test/plain", events: ["x"] }, a.secret)), "invalid_subscription", "http URLs are rejected");
  assert.equal(await errorCode(await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/ok", events: [] }, a.secret)), "invalid_subscription_request", "events must be non-empty");
  assert.equal(await errorCode(await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/ok", events: ["x"], secret: "short" }, a.secret)), "invalid_subscription",
    "short caller secrets are rejected");
  assert.equal(await errorCode(await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/ok", events: ["x"], extra: 1 }, a.secret)), "invalid_subscription_request");

  const subId = (await (await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/a", events: ["x"] }, a.secret)).json()).subscriptionId;
  assert.equal(await errorCode(await del(origin, `/api/agent-webhooks/${subId}`, b.secret)), "unknown_subscription",
    "another identity cannot unsubscribe it, and learns nothing");
  assert.deepEqual((await (await get(origin, "/api/agent-webhooks", b.secret)).json()).subscriptions, [],
    "subscriptions are scoped to the owning identity");
});

test("manifest is derived, public, and validates", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);

  const res = await get(origin, "/api/agent-manifest");
  assert.equal(res.status, 200, "manifest needs no auth");
  const doc = await res.json();
  assert.equal(doc.version, "1.0.0");
  assert.equal(doc.service.name, "Project Room");
  assert.ok(doc.service.origin.startsWith("https://"));
  assert.ok(doc.auth.schemes.some(s => s.scheme === "agent-api-key" && s.format === "Bearer rak_<secret>"));
  assert.ok(doc.auth.schemes.some(s => s.scheme === "identity-secret"));
  assert.ok(doc.enrollment.flows.length > 0);
  assert.equal(doc.directory.url, `${doc.service.origin}/api/agents/directory`);
  assert.equal(validatePluginManifest(doc), true);

  const wellKnown = await get(origin, WELL_KNOWN_PATH);
  assert.equal(wellKnown.status, 200);
  const wellKnownDoc = await wellKnown.json();
  // generatedAt is rebuilt per request; everything else must be identical.
  delete wellKnownDoc.generatedAt; delete doc.generatedAt;
  assert.deepEqual(wellKnownDoc, doc, "the well-known path serves the same document");
});

test("mutating plug-in routes are rate-limited per address", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("rate-agent");
  let lastStatus = null;
  for (let i = 0; i < 21; i++) {
    lastStatus = (await post(origin, "/api/agent-keys", { scopes: ["rooms:read"] }, identity.secret)).status;
  }
  assert.equal(lastStatus, 429, "the 21st issue inside a minute is rate-limited");
});
