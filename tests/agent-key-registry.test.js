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
// ---- key binding at identity issuance ----


// ---- rotation overlap ----


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


// ---- explicit validity windows ----


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
