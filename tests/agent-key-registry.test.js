// Integration map slice 9 — agent public-key registry.
//
// Registry lifecycle (register -> rotate -> revoke) against a real store,
// key binding at identity issuance, the rotation-overlap acceptance rule,
// and the HTTP key routes. The registry is room-local, operator-attested
// plumbing: nothing here asserts trustlessness or touches a chain.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { signPubkeyClaim, verifyPubkeyClaim, ClaimError } from "../server/signed-claims.mjs";
import { generateKeyPair } from "../server/agent-card-signing.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

// A store with a controllable clock. /tmp is fine for the disposable DB:
// TMPDIR is pinned inside the worktree when the suite runs.
const openStore = t => {
  let now = 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), "key-registry-test-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { now: () => now });
  t.after(() => store.close());
  return { store, setNow: value => { now = value; } };
};

const serviceCode = fn => {
  try { fn(); } catch (error) { return `${error.status}:${error.code}`; }
  return "no-throw";
};
const claimCode = fn => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof ClaimError);
    return error.code;
  }
  return "no-throw";
};
const keysFor = store => agentId => store.keyRegistry.keysFor(agentId);

// ---- key binding at identity issuance ----

test("identity creation binds an Ed25519 key and registers it", t => {
  const { store } = openStore(t);
  const created = store.identities.create("Keyed agent");
  assert.ok(typeof created.publicKey === "string");
  assert.ok(typeof created.privateKey === "string");
  assert.equal(Buffer.from(created.publicKey, "base64").length, 32);
  assert.equal(Buffer.from(created.privateKey, "base64").length, 32);
  assert.notEqual(created.publicKey, created.privateKey);
  const keys = store.keyRegistry.keysFor(created.identityId);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].publicKey, created.publicKey);
  assert.equal(keys[0].validFrom, 1_000_000);
  assert.equal(keys[0].validUntil, null);
  assert.equal(keys[0].revokedAt, null);
  assert.ok(Object.isFrozen(keys[0]));
  // The issuance key signs a claim that verifies against the registry.
  const token = signPubkeyClaim({ agentId: created.identityId, action: "room.join",
    payload: {}, privateKey: created.privateKey, now: () => 1_000_000 });
  const claim = verifyPubkeyClaim({ token, keysFor: keysFor(store), now: () => 1_000_000 });
  assert.equal(claim.agentId, created.identityId);
});

// ---- rotation overlap ----

test("rotation: claims signed during the overlap verify; afterwards the old key is rejected", t => {
  const { store, setNow } = openStore(t);
  const created = store.identities.create("Rotating agent");
  const oldKey = { publicKey: created.publicKey, privateKey: created.privateKey };
  const fresh = generateKeyPair();

  // Old key signs before rotation.
  const preRotation = signPubkeyClaim({ agentId: created.identityId, action: "work.claim",
    payload: {}, privateKey: oldKey.privateKey, ttlMs: 10 ** 9, now: () => 1_000_000 });

  setNow(2_000_000);
  const rotated = store.keyRegistry.rotateKey(created.identityId, {
    identitySecret: created.secret, newPublicKey: fresh.publicKey, overlapMs: 60_000 });
  assert.equal(rotated.publicKey, fresh.publicKey);
  assert.equal(rotated.validFrom, 2_000_000);
  assert.equal(rotated.closedKeys, 1);

  // Both keys verify during the overlap window.
  const duringOverlap = signPubkeyClaim({ agentId: created.identityId, action: "work.claim",
    payload: {}, privateKey: oldKey.privateKey, ttlMs: 10 ** 9, now: () => 2_030_000 });
  assert.equal(verifyPubkeyClaim({ token: duringOverlap, keysFor: keysFor(store), now: () => 2_040_000 }).issuedAt, 2_030_000);
  const newKeyClaim = signPubkeyClaim({ agentId: created.identityId, action: "work.claim",
    payload: {}, privateKey: fresh.privateKey, ttlMs: 10 ** 9, now: () => 2_040_000 });
  assert.equal(verifyPubkeyClaim({ token: newKeyClaim, keysFor: keysFor(store), now: () => 2_040_000 }).issuedAt, 2_040_000);
  // The pre-rotation claim still verifies after rotation: verification
  // binds issuedAt to the window, not verify-time.
  assert.equal(verifyPubkeyClaim({ token: preRotation, keysFor: keysFor(store), now: () => 2_040_000 }).issuedAt, 1_000_000);

  // After the overlap, the old key's window is closed: a claim issued then fails.
  const afterOverlap = signPubkeyClaim({ agentId: created.identityId, action: "work.claim",
    payload: {}, privateKey: oldKey.privateKey, ttlMs: 10 ** 9, now: () => 2_060_001 });
  assert.equal(claimCode(() => verifyPubkeyClaim({ token: afterOverlap, keysFor: keysFor(store), now: () => 2_060_002 })), "invalid_claim");

  // The registry is append-only: both generations remain listed.
  const keys = store.keyRegistry.keysFor(created.identityId);
  assert.equal(keys.length, 2);
  assert.equal(keys[0].publicKey, oldKey.publicKey);
  assert.equal(keys[0].validUntil, 2_060_000);
  assert.equal(keys[0].supersededBy, fresh.publicKey);
  assert.equal(keys[1].publicKey, fresh.publicKey);
});

test("rotation rejects bad inputs and wrong ownership", t => {
  const { store } = openStore(t);
  const created = store.identities.create("Rotating agent");
  const fresh = generateKeyPair();
  const other = store.identities.create("Other agent");
  assert.equal(serviceCode(() => store.keyRegistry.rotateKey(created.identityId,
    { identitySecret: "pri_" + "x".repeat(43), newPublicKey: fresh.publicKey })), "401:unauthenticated");
  assert.equal(serviceCode(() => store.keyRegistry.rotateKey(created.identityId,
    { identitySecret: other.secret, newPublicKey: fresh.publicKey })), "401:unauthenticated");
  assert.equal(serviceCode(() => store.keyRegistry.rotateKey(created.identityId,
    { identitySecret: created.secret, newPublicKey: "bogus" })), "422:invalid_key");
  assert.equal(serviceCode(() => store.keyRegistry.rotateKey(created.identityId,
    { identitySecret: created.secret, newPublicKey: fresh.publicKey, overlapMs: -1 })), "422:invalid_key");
  assert.equal(serviceCode(() => store.keyRegistry.rotateKey(created.identityId,
    { identitySecret: created.secret, newPublicKey: fresh.publicKey, overlapMs: 31 * 24 * 3600_000 })), "422:invalid_key");
  // Rotating to the already-registered key is a conflict.
  assert.equal(serviceCode(() => store.keyRegistry.rotateKey(created.identityId,
    { identitySecret: created.secret, newPublicKey: created.publicKey })), "409:key_already_registered");
  assert.equal(serviceCode(() => store.keyRegistry.rotateKey("ai_nope",
    { identitySecret: created.secret, newPublicKey: fresh.publicKey })), "401:unauthenticated");
});

// ---- revocation ----

test("revocation: claims issued after revokedAt fail; earlier claims still verify", t => {
  const { store, setNow } = openStore(t);
  const created = store.identities.create("Revoked agent");
  const before = signPubkeyClaim({ agentId: created.identityId, action: "x",
    payload: {}, privateKey: created.privateKey, ttlMs: 10 ** 9, now: () => 1_000_000 });
  setNow(5_000_000);
  const revoked = store.keyRegistry.revokeKey(created.identityId,
    { identitySecret: created.secret, publicKey: created.publicKey });
  assert.equal(revoked.revokedAt, 5_000_000);
  // Issued before revocation: still verifies afterwards.
  assert.equal(verifyPubkeyClaim({ token: before, keysFor: keysFor(store), now: () => 6_000_000 }).issuedAt, 1_000_000);
  // Issued at/after revocation: rejected.
  const after = signPubkeyClaim({ agentId: created.identityId, action: "x",
    payload: {}, privateKey: created.privateKey, ttlMs: 10 ** 9, now: () => 5_000_000 });
  assert.equal(claimCode(() => verifyPubkeyClaim({ token: after, keysFor: keysFor(store), now: () => 5_000_001 })), "invalid_claim");
  // Re-revoking is a no-op returning the existing record.
  const again = store.keyRegistry.revokeKey(created.identityId,
    { identitySecret: created.secret, publicKey: created.publicKey });
  assert.equal(again.revokedAt, 5_000_000);
  // Unknown keys and wrong owners are rejected.
  const fresh = generateKeyPair();
  assert.equal(serviceCode(() => store.keyRegistry.revokeKey(created.identityId,
    { identitySecret: created.secret, publicKey: fresh.publicKey })), "404:key_not_found");
  assert.equal(serviceCode(() => store.keyRegistry.revokeKey(created.identityId,
    { identitySecret: "pri_" + "y".repeat(43), publicKey: created.publicKey })), "401:unauthenticated");
});

// ---- explicit validity windows ----

test("expired keys reject claims issued after validUntil", t => {
  const { store } = openStore(t);
  const created = store.identities.create("Windowed agent");
  // Register a second key with a fixed window, bypassing create's binding.
  const kp = generateKeyPair();
  const entry = store.keyRegistry.registerKey(created.identityId, kp.publicKey, { validFrom: 100, validUntil: 200 });
  assert.equal(entry.validUntil, 200);
  const late = signPubkeyClaim({ agentId: created.identityId, action: "x",
    payload: {}, privateKey: kp.privateKey, ttlMs: 10 ** 9, now: () => 250 });
  assert.equal(claimCode(() => verifyPubkeyClaim({ token: late, keysFor: keysFor(store), now: () => 251 })), "invalid_claim");
  // Duplicate registration is a conflict.
  assert.equal(serviceCode(() => store.keyRegistry.registerKey(created.identityId, kp.publicKey, { validFrom: 100 })), "409:key_already_registered");
  // Registering for an unknown identity is a 404.
  assert.equal(serviceCode(() => store.keyRegistry.registerKey("ai_nope", kp.publicKey, {})), "404:identity_not_found");
});

// ---- HTTP integration ----

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

test("HTTP: key list is public; rotate/revoke are owner-scoped", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("HTTP agent");
  const other = f.store.identities.create("Other agent");

  // The public read surface needs no auth and never leaks the private key.
  const listed = await get(origin, `/api/agent-identities/${agent.identityId}/keys`);
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(listedBody.identityId, agent.identityId);
  assert.equal(listedBody.keys.length, 1);
  assert.equal(listedBody.keys[0].publicKey, agent.publicKey);
  assert.ok(!JSON.stringify(listedBody).includes(agent.privateKey));
  assert.equal((await get(origin, "/api/agent-identities/ai_nope/keys")).status, 404);

  // Cross-identity rotation is rejected.
  const fresh = generateKeyPair();
  const cross = await post(origin, `/api/agent-identities/${agent.identityId}/keys/rotate`,
    { newPublicKey: fresh.publicKey }, other.secret);
  assert.equal(cross.status, 403);
  assert.equal(await errorCode(cross), "cross_identity");

  // Rotate with the identity's own secret.
  const rotated = await post(origin, `/api/agent-identities/${agent.identityId}/keys/rotate`,
    { newPublicKey: fresh.publicKey, overlapMs: 60_000 }, agent.secret);
  assert.equal(rotated.status, 200);
  const rotatedBody = await rotated.json();
  assert.equal(rotatedBody.publicKey, fresh.publicKey);
  assert.equal(rotatedBody.closedKeys, 1);

  // The rotated list shows both generations.
  const relisted = await (await get(origin, `/api/agent-identities/${agent.identityId}/keys`)).json();
  assert.equal(relisted.keys.length, 2);

  // Revoke the old key.
  const revoked = await post(origin, `/api/agent-identities/${agent.identityId}/keys/revoke`,
    { publicKey: agent.publicKey }, agent.secret);
  assert.equal(revoked.status, 200);
  assert.ok(typeof (await revoked.json()).revokedAt === "number");

  // Malformed rotate/revoke bodies are 422.
  const badRotate = await post(origin, `/api/agent-identities/${agent.identityId}/keys/rotate`,
    { nope: 1 }, agent.secret);
  assert.equal(badRotate.status, 422);
  const badRevoke = await post(origin, `/api/agent-identities/${agent.identityId}/keys/revoke`,
    { publicKey: "bogus" }, agent.secret);
  assert.equal(badRevoke.status, 422);
});
