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
import { generateKeyPair, signCard, signKeyRotation, verifyCardSignature } from "../server/agent-card-signing.mjs";

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
const errorMessage = async res => (await res.json()).error?.message ?? "";

const fixtureCard = (overrides = {}) => ({
  name: "Fixture Agent",
  description: "A synthetic test agent for plug-in surface tests.",
  url: "https://agent.example.test",
  capabilities: ["chat"],
  skills: ["fixtures"],
  version: "1.0.0",
  ...overrides,
});

// RC-2026-09-18-014: directory publishes must be signed. Returns the request
// body for POST /api/agent-directory/cards (optionally with visibility,
// rotationSignature, recovery).
const signedPublishBody = (agentId, card, keyPair, extras = {}) => ({
  agentId,
  card,
  publicKey: keyPair.publicKey,
  signature: signCard({ agentId, card, privateKey: keyPair.privateKey }),
  ...extras,
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
  // RC-2026-09-18-024: the 201 carries the presentation-ready credential.
  assert.equal(key.credential, `rak_${key.secret}`, "credential is the exact Authorization-header value");
  // RC-2026-09-18-028: issue carries scope-filtered next[] guidance (mirrors the signup next[]).
  const nextActions = key.next.map(n => n.action);
  assert.deepEqual(nextActions, ["publish-card", "read-directory", "read-manifest"],
    "directory:publish key unlocks publish-card plus the unauthenticated reads, not webhooks:manage actions");
  for (const step of key.next) {
    assert.ok(typeof step.method === "string" && typeof step.path === "string" && typeof step.description === "string",
      "every next step names its method, path, and what to do");
  }
  // A webhooks:manage key sees subscribe-webhooks instead of publish-card.
  const wh = await post(origin, "/api/agent-keys", { scopes: ["webhooks:manage"] }, identity.secret);
  const whActions = (await wh.json()).next.map(n => n.action);
  assert.deepEqual(whActions, ["subscribe-webhooks", "read-directory", "read-manifest"]);
  // The raw secret alone is not a valid presented credential: auth requires the prefix.
  assert.equal(f.store.agentPlugin.verifyPresentedApiKey(key.secret), null);
  const presented = f.store.agentPlugin.verifyPresentedApiKey(key.credential);
  assert.equal(presented?.keyId, key.keyId, "the credential authenticates end to end");

  const listed = await get(origin, "/api/agent-keys", identity.secret);
  assert.equal(listed.status, 200);
  const listBody = await listed.json();
  const listedKey = listBody.keys.find(k => k.keyId === key.keyId);
  assert.ok(listedKey, "the issued key is listed");
  assert.ok(!("secret" in listedKey), "list output has no secret");
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
  // RC-2026-09-18-024: rotation also carries the presentation-ready credential.
  assert.equal(rotatedBody.credential, `rak_${rotatedBody.secret}`);
  // RC-2026-09-18-028: rotation carries the same scope-filtered next[] guidance
  // (rooms:read grants no scoped action, so only the unauthenticated reads show).
  assert.deepEqual(rotatedBody.next.map(n => n.action), ["read-directory", "read-manifest"]);
  const rotatedPresented = f.store.agentPlugin.verifyPresentedApiKey(rotatedBody.credential);
  assert.equal(rotatedPresented?.keyId, keyId, "the rotated credential authenticates");
  assert.equal(f.store.agentPlugin.verifyPresentedApiKey(rotatedBody.secret), null, "raw secret without prefix is rejected");

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
  const keyPair = generateKeyPair();

  const published = await post(origin, "/api/agent-directory/cards",
    signedPublishBody("fixture-agent", fixtureCard(), keyPair, { visibility: "public" }), identity.secret);
  assert.equal(published.status, 201);
  const publishedDoc = await published.json();
  assert.equal(publishedDoc.agentId, "fixture-agent");
  assert.equal(publishedDoc.publicKey, keyPair.publicKey);
  // RC-2026-09-18-037: the publish response names the card's lifecycle.
  assert.deepEqual(publishedDoc.next.map(n => n.action), ["see-it-live", "update-card", "withdraw-card"]);
  assert.equal(publishedDoc.next[0].path, "/api/agent-directory");
  assert.equal(publishedDoc.next[2].method, "DELETE");
  assert.ok(publishedDoc.next[2].path.includes("/api/agent-directory/cards/fixture-agent"));

  // The public document needs no auth.
  const doc = await (await get(origin, "/api/agent-directory")).json();
  assert.equal(doc.version, "1.0.0");
  assert.ok(doc.origin.startsWith("https://"), "document origin is https");
  const listed = doc.agents.find(a => a.agentId === "fixture-agent");
  assert.ok(listed, "published card appears in the public document");
  assert.ok(listed.cardUrl.endsWith("/api/agents/directory/fixture-agent"));
  // The listed card carries its key envelope, verifiable offline.
  assert.ok(verifyCardSignature({
    agentId: listed.agentId,
    card: { name: listed.name, description: listed.description, url: listed.url,
      capabilities: [...listed.capabilities], skills: [...listed.skills], version: listed.version },
    publicKey: listed.publicKey,
    signature: listed.signature,
  }), "listed card verifies offline against its publicKey");

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

test("unsigned and mis-signed publishes are rejected with 422", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("dir-sig");
  const keyPair = generateKeyPair();
  const other = generateKeyPair();

  // No signature at all.
  assert.equal((await post(origin, "/api/agent-directory/cards",
    { agentId: "unsigned-agent", card: fixtureCard() }, identity.secret)).status, 422);
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    { agentId: "unsigned-agent", card: fixtureCard() }, identity.secret)), "invalid_card");
  // publicKey without signature.
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    { agentId: "unsigned-agent", card: fixtureCard(), publicKey: keyPair.publicKey }, identity.secret)), "invalid_card");
  // Signature from the wrong key.
  const forged = signedPublishBody("forged-agent", fixtureCard(), other);
  forged.publicKey = keyPair.publicKey;
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards", forged, identity.secret)),
    "invalid_card_signature");
  // Signature over a tampered card body.
  const tampered = signedPublishBody("tampered-agent", fixtureCard(), keyPair);
  tampered.card = fixtureCard({ description: "Tampered after signing." });
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards", tampered, identity.secret)),
    "invalid_card_signature");

  // RC-2026-09-18-027: every publish-path 422 points at the signing guide.
  const shapeMsg = await errorMessage(await post(origin, "/api/agent-directory/cards",
    { agentId: "doc-pointer-agent", card: fixtureCard() }, identity.secret));
  assert.ok(shapeMsg.includes("docs/SIGNED-AGENT-CARDS.md"),
    `shape 422 teaches where to look: ${shapeMsg}`);
  const badKey = signedPublishBody("badkey-agent", fixtureCard(), keyPair);
  badKey.publicKey = "not-canonical-base64!!!";
  const badKeyRes = await post(origin, "/api/agent-directory/cards", badKey, identity.secret);
  assert.equal(badKeyRes.status, 422);
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards", badKey, identity.secret)),
    "invalid_card_signature");
  const badKeyMsg = await errorMessage(badKeyRes);
  assert.ok(badKeyMsg.includes("docs/SIGNED-AGENT-CARDS.md"),
    `invalid_card_signature 422 teaches where to look: ${badKeyMsg}`);
});

test("key rotation over HTTP requires the old key's rotation signature", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("dir-rotate");
  const oldKp = generateKeyPair();
  const newKp = generateKeyPair();

  const first = await post(origin, "/api/agent-directory/cards",
    signedPublishBody("rotate-agent", fixtureCard(), oldKp), identity.secret);
  assert.equal(first.status, 201);

  // Key swap without the chain-of-custody statement is rejected.
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    signedPublishBody("rotate-agent", fixtureCard(), newKp), identity.secret)), "invalid_card_signature");

  // With the old key's rotation signature it succeeds.
  const rotationSignature = signKeyRotation({
    agentId: "rotate-agent", card: fixtureCard(), newPublicKey: newKp.publicKey, oldPrivateKey: oldKp.privateKey,
  });
  const rotated = await post(origin, "/api/agent-directory/cards",
    signedPublishBody("rotate-agent", fixtureCard(), newKp, { rotationSignature }), identity.secret);
  assert.equal(rotated.status, 201);
  assert.equal((await rotated.json()).publicKey, newKp.publicKey);

  // The old key is now dead for this agent.
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    signedPublishBody("rotate-agent", fixtureCard(), oldKp), identity.secret)), "invalid_card_signature");
});

test("owner-signed recovery rotates a lost key; scoped keys cannot", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("dir-recover");
  const oldKp = generateKeyPair();
  const newKp = generateKeyPair();

  assert.equal((await post(origin, "/api/agent-directory/cards",
    signedPublishBody("recover-agent", fixtureCard(), oldKp), identity.secret)).status, 201);

  // A scoped API key with directory:publish cannot waive the rotation chain.
  const scoped = await (await post(origin, "/api/agent-keys",
    { scopes: ["directory:publish"] }, identity.secret)).json();
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    signedPublishBody("recover-agent", fixtureCard(), newKp, { recovery: true }), scoped.credential)),
    "insufficient_scope");

  // The identity (owner) secret can recover the lost key.
  const recovered = await post(origin, "/api/agent-directory/cards",
    signedPublishBody("recover-agent", fixtureCard(), newKp, { recovery: true }), identity.secret);
  assert.equal(recovered.status, 201);
  assert.equal((await recovered.json()).publicKey, newKp.publicKey);
});

test("private cards stay out of the public document; ownership is enforced", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const owner = f.store.identities.create("dir-owner");
  const stranger = f.store.identities.create("dir-stranger");
  const ownerKeys = generateKeyPair();
  const strangerKeys = generateKeyPair();

  const published = await post(origin, "/api/agent-directory/cards",
    signedPublishBody("quiet-agent", fixtureCard({ name: "Quiet Agent" }), ownerKeys, { visibility: "private" }), owner.secret);
  assert.equal(published.status, 201);

  const doc = await (await get(origin, "/api/agent-directory")).json();
  assert.equal(doc.agents.find(a => a.agentId === "quiet-agent"), undefined, "private card is not listed publicly");
  assert.equal((await get(origin, "/api/agents/directory/quiet-agent")).status, 404, "private card has no public card URL");

  // Another identity cannot steal the agentId or withdraw the card (signed
  // so it reaches the ownership check rather than the signature gate).
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    signedPublishBody("quiet-agent", fixtureCard({ name: "Impostor" }), strangerKeys), stranger.secret)), "card_owned_by_another_identity");
  assert.equal(await errorCode(await del(origin, "/api/agent-directory/cards/quiet-agent", stranger.secret)), "unknown_card");

  // Card validation errors surface as 422.
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    signedPublishBody("bad-agent", { name: "x" }, ownerKeys), owner.secret)), "invalid_directory");
  assert.equal(await errorCode(await post(origin, "/api/agent-directory/cards",
    signedPublishBody("BAD ID", fixtureCard(), ownerKeys), owner.secret)), "invalid_directory");

  // Owner republish updates the card (same key).
  const republished = await post(origin, "/api/agent-directory/cards",
    signedPublishBody("quiet-agent", fixtureCard({ name: "Quiet Agent", version: "1.1.0" }), ownerKeys, { visibility: "public" }), owner.secret);
  assert.equal(republished.status, 201);
  assert.equal((await (await get(origin, "/api/agents/directory/quiet-agent")).json()).version, "1.1.0");
});

test("directory search filters query and capability", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("dir-search");
  await post(origin, "/api/agent-directory/cards",
    signedPublishBody("searchable-one", fixtureCard({ name: "Weather Bot", capabilities: ["weather"] }), generateKeyPair()), identity.secret);
  await post(origin, "/api/agent-directory/cards",
    signedPublishBody("searchable-two", fixtureCard({ name: "Chat Bot", capabilities: ["chat"] }), generateKeyPair()), identity.secret);

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
  // RC-2026-09-18-039: the 201 names the secret's job and the debugging path.
  assert.deepEqual(sub.next.map(n => n.action), ["store-secret", "verify-deliveries", "check-journal"]);
  assert.ok(sub.next[0].description.includes("exactly once"));
  assert.ok(sub.next[2].path.includes(`/api/agent-webhooks/${sub.subscriptionId}/deliveries`));
  assert.equal(sub.deliveries, 0);

  // A caller-supplied secret is never echoed back.
  const ownSecret = "caller-supplied-signing-secret-xyz";
  const supplied = await (await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/other", events: ["*"], secret: ownSecret }, identity.secret)).json();
  assert.ok(!("secret" in supplied), "caller-supplied secret is not echoed");
  // RC-2026-09-18-039: with a caller-supplied secret there is nothing to store,
  // so next[] skips store-secret.
  assert.deepEqual(supplied.next.map(n => n.action), ["verify-deliveries", "check-journal"]);

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

test("delivery journal is readable by the owning identity; cross-identity reads 404", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("hook-journal");
  const other = f.store.identities.create("hook-journal-other");

  const subscribed = await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/agent", events: ["message.posted"] }, identity.secret);
  assert.equal(subscribed.status, 201);
  const { subscriptionId } = await subscribed.json();

  // No auth, wrong identity, unknown id.
  assert.equal((await get(origin, `/api/agent-webhooks/${subscriptionId}/deliveries`)).status, 401);
  assert.equal(await errorCode(await get(origin, `/api/agent-webhooks/${subscriptionId}/deliveries`, other.secret)), "unknown_subscription");
  assert.equal(await errorCode(await get(origin, "/api/agent-webhooks/sub_missing/deliveries", identity.secret)), "unknown_subscription");

  // Empty journal reads clean.
  const empty = await (await get(origin, `/api/agent-webhooks/${subscriptionId}/deliveries`, identity.secret)).json();
  assert.equal(empty.subscriptionId, subscriptionId);
  assert.deepEqual(empty.deliveries, []);

  // Server-side dispatch writes journal entries the owner can read.
  const delivery = f.store.agentPlugin.buildWebhookDelivery(subscriptionId, { eventType: "message.posted", data: { messageId: "m1" } });
  f.store.agentPlugin.recordWebhookAttempt(delivery.deliveryId, { ok: false, error: "connection refused" });
  const journal = await (await get(origin, `/api/agent-webhooks/${subscriptionId}/deliveries`, identity.secret)).json();
  assert.equal(journal.deliveries.length, 1);
  const entry = journal.deliveries[0];
  assert.equal(entry.deliveryId, delivery.deliveryId);
  assert.equal(entry.eventType, "message.posted");
  assert.equal(entry.state, "failed");
  assert.equal(entry.attempts, 1);
  assert.equal(entry.error, "connection refused");
  assert.ok(!("secret" in entry) && !("signature" in entry) && !("url" in entry),
    "journal entries never carry secrets, signatures, or the endpoint URL");
});

test("webhook validation and cross-identity isolation", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const a = f.store.identities.create("hook-a");
  const b = f.store.identities.create("hook-b");

  assert.equal(await errorCode(await post(origin, "/api/agent-webhooks",
    { url: "http://hooks.example.test/plain", events: ["message.posted"] }, a.secret)), "invalid_subscription", "http URLs are rejected");
  assert.equal(await errorCode(await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/ok", events: [] }, a.secret)), "invalid_subscription_request", "events must be non-empty");
  // RC-2026-09-18-031: unknown event names fail fast with the taught vocabulary
  // instead of a 201 that never fires.
  const badEvents = await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/ok", events: ["message-posted"] }, a.secret);
  assert.equal(badEvents.status, 422);
  assert.equal(await errorCode(await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/ok", events: ["message-posted"] }, a.secret)), "invalid_subscription_request");
  const badEventsMsg = (await badEvents.json()).error.message;
  assert.ok(badEventsMsg.includes('"message-posted"'), "names the unknown event");
  assert.ok(badEventsMsg.includes("message.posted"), "teaches the valid spelling");
  assert.equal(await errorCode(await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/ok", events: ["message.posted"], secret: "short" }, a.secret)), "invalid_subscription",
    "short caller secrets are rejected");
  assert.equal(await errorCode(await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/ok", events: ["message.posted"], extra: 1 }, a.secret)), "invalid_subscription_request");

  const subId = (await (await post(origin, "/api/agent-webhooks",
    { url: "https://hooks.example.test/a", events: ["message.posted"] }, a.secret)).json()).subscriptionId;
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

test("a failed SQLite write-through rolls back the in-memory Map mutation", async t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  const plugins = f.store.agentPlugin;
  const identity = f.store.identities.create("rollback-agent");
  const before = plugins.keys.size;
  // Sabotage the write-through: the pure module issues the key (Map grows),
  // then the INSERT throws; the Map entry must be restored.
  const realPrepare = plugins.db.prepare.bind(plugins.db);
  plugins.db.prepare = sql => {
    if (typeof sql === "string" && sql.includes("INSERT INTO agent_api_keys")) {
      throw new Error("synthetic write failure");
    }
    return realPrepare(sql);
  };
  try {
    assert.throws(() => plugins.issueApiKey({ identityId: identity.identityId, scopes: ["rooms:read"] }),
      /synthetic write failure/);
  } finally {
    plugins.db.prepare = realPrepare;
  }
  assert.equal(plugins.keys.size, before, "the issued key was rolled back from the in-memory Map");
  assert.equal(plugins.db.prepare("SELECT COUNT(*) AS n FROM agent_api_keys").get().n, before,
    "no key row leaked into SQLite either");
  // The store still works after the rollback.
  const issued = plugins.issueApiKey({ identityId: identity.identityId, scopes: ["rooms:read"] });
  assert.match(issued.keyId, /^rak_[A-Za-z0-9_-]+$/);
});
