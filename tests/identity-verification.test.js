// RC-2026-09-18-049 — agent identity verification tiers.
// Pure-module unit tests plus HTTP integration tests for the attestation
// routes, the room verification-policy gate, and the directory trust tier.
import test from "node:test";
import assert from "node:assert/strict";
import { createIdentityVerification, VERIFIED, UNVERIFIED } from "../server/identity-verification.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

const AI = "ai_testAgentOne";
const OWNER = "ai_roomOwnerAttester";

const frozenNow = 1780000000000;
const fresh = () => createIdentityVerification({ clock: () => frozenNow });

test("unattested identities are unverified", () => {
  const v = fresh();
  assert.equal(v.level(AI), UNVERIFIED);
  assert.equal(v.isVerified(AI), false);
  assert.equal(v.attestation(AI), null);
  assert.deepEqual(v.attestations(), []);
  assert.equal(v.size(), 0);
});

test("verify records a frozen owner attestation", () => {
  const v = fresh();
  const record = v.verify(AI, { verifiedBy: OWNER });
  assert.deepEqual(record, { identityId: AI, level: VERIFIED, verifiedBy: OWNER, verifiedAt: frozenNow });
  assert.ok(Object.isFrozen(record));
  assert.equal(v.level(AI), VERIFIED);
  assert.equal(v.isVerified(AI), true);
  assert.deepEqual(v.attestation(AI), record);
  assert.deepEqual(v.attestations(), [record]);
  assert.equal(v.size(), 1);
});

test("verify validates identityId and verifiedBy", () => {
  const v = fresh();
  assert.throws(() => v.verify("", { verifiedBy: OWNER }), /identityId/);
  assert.throws(() => v.verify("x".repeat(129), { verifiedBy: OWNER }), /identityId/);
  assert.throws(() => v.verify(42, { verifiedBy: OWNER }), /identityId/);
  assert.throws(() => v.verify(AI, { verifiedBy: "" }), /verifiedBy/);
  assert.throws(() => v.verify(AI, {}), /verifiedBy/);
  assert.equal(v.size(), 0);
});

test("re-verify is idempotent: one row, refreshed timestamp", () => {
  let now = frozenNow;
  const v = createIdentityVerification({ clock: () => now });
  v.verify(AI, { verifiedBy: OWNER });
  now += 5000;
  const again = v.verify(AI, { verifiedBy: OWNER });
  assert.equal(again.verifiedAt, frozenNow + 5000);
  assert.equal(v.size(), 1);
  assert.deepEqual(v.attestations(), [again]);
});

test("unverify removes the attestation and is idempotent", () => {
  const v = fresh();
  assert.deepEqual(v.unverify(AI), { identityId: AI, level: UNVERIFIED });
  v.verify(AI, { verifiedBy: OWNER });
  assert.deepEqual(v.unverify(AI), { identityId: AI, level: UNVERIFIED });
  assert.equal(v.level(AI), UNVERIFIED);
  assert.equal(v.size(), 0);
});

test("unverify validates identityId", () => {
  const v = fresh();
  assert.throws(() => v.unverify(""), /identityId/);
});

test("constructor validates the injected clock", () => {
  assert.throws(() => createIdentityVerification({ clock: "now" }), /clock/);
});

// ---- HTTP integration ----

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
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
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
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

// Attestation authority comes from owning a room: bind the attester identity
// to the fixture room's owner member (the fixture seeds "commons" with an
// owner member but no identity bound to it).
function makeAttester(f) {
  const attester = f.store.identities.create("Attesting owner");
  f.store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
    .run("commons", attester.identityId, "owner", Date.now());
  return attester;
}

test("attestation flow: verify -> read -> unverify -> read", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Working agent");

  const verifyRes = await post(origin, `/api/agent-identities/${agent.identityId}/verify`, {}, attester.secret);
  assert.equal(verifyRes.status, 201);
  const record = await verifyRes.json();
  assert.equal(record.level, "verified");
  assert.equal(record.verifiedBy, attester.identityId);
  assert.ok(typeof record.verifiedAt === "number");

  const readRes = await get(origin, `/api/agent-identities/${agent.identityId}/verification`);
  assert.equal(readRes.status, 200);
  assert.deepEqual(await readRes.json(), record);

  const unverifyRes = await del(origin, `/api/agent-identities/${agent.identityId}/verify`, attester.secret);
  assert.equal(unverifyRes.status, 200);
  const removed = await unverifyRes.json();
  assert.equal(removed.level, "unverified");
  assert.equal(removed.identityId, agent.identityId);

  const after = await (await get(origin, `/api/agent-identities/${agent.identityId}/verification`)).json();
  assert.deepEqual(after, { identityId: agent.identityId, level: "unverified" });
});

test("only a room owner can attest", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Working agent");
  const bystander = f.store.identities.create("Bystander");
  const path = `/api/agent-identities/${agent.identityId}/verify`;

  assert.equal((await post(origin, path, {})).status, 401);
  assert.equal(await errorCode(await post(origin, path, {}, bystander.secret)), "not_room_owner");
  assert.equal(await errorCode(await del(origin, path, bystander.secret)), "not_room_owner");
  // Scoped keys are not the owner secret.
  const scoped = await (await post(origin, "/api/agent-keys", { scopes: ["directory:read"] }, bystander.secret)).json();
  assert.equal(await errorCode(await post(origin, path, {}, scoped.credential)), "insufficient_scope");
});

test("verify rejects unknown identities", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const attester = makeAttester(f);
  assert.equal(await errorCode(await post(origin, "/api/agent-identities/ai_noSuchIdentity/verify", {}, attester.secret)), "identity_not_found");
});

test("directory cards surface the verification tier", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Card agent");

  // The same key pins the card, so re-publishes must reuse it (key rotation
  // without the old key's signature is a 422, by design).
  const keyPair = generateKeyPair();
  const publish = async agentId => {
    const card = { name: "Tier Agent", description: "verification tier fixture", capabilities: ["chat"], version: "1.0.0" };
    return post(origin, "/api/agent-directory/cards", {
      agentId, card, publicKey: keyPair.publicKey, signature: signCard({ agentId, card, privateKey: keyPair.privateKey }),
    }, agent.secret);
  };

  const plainRes = await publish("tier-agent");
  assert.equal(plainRes.status, 201);
  const plainDoc = await plainRes.json();
  assert.equal(plainDoc.trust.verification, "unverified");

  await post(origin, `/api/agent-identities/${agent.identityId}/verify`, {}, attester.secret);
  const reRes = await publish("tier-agent");
  assert.equal(reRes.status, 201);
  const verifiedDoc = await reRes.json();
  assert.equal(verifiedDoc.trust.verification, "verified");
  assert.equal(verifiedDoc.trust.approvedBy, attester.identityId);
  assert.ok(typeof verifiedDoc.trust.approvedAt === "number");

  // The public read carries the same tier.
  const publicDoc = await (await get(origin, "/api/agents/directory/tier-agent")).json();
  assert.equal(publicDoc.trust.verification, "verified");
  assert.equal(publicDoc.trust.approvedBy, attester.identityId);
});

test("room verification-policy gates identity linking", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const memberKey = f.keys.guest; // human member, no manage_members
  const policyPath = "/api/rooms/commons/verification-policy";

  const read = await (await get(origin, policyPath, memberKey)).json();
  assert.equal(read.requireVerified, false);

  assert.equal(await errorCode(await post(origin, policyPath, { requireVerified: true }, memberKey)), "access_denied");
  assert.equal(await errorCode(await post(origin, policyPath, { requireVerified: "yes" }, ownerKey)), "invalid_policy");

  const set = await post(origin, policyPath, { requireVerified: true }, ownerKey);
  assert.equal(set.status, 200);
  const policy = await set.json();
  assert.equal(policy.requireVerified, true);
  assert.equal(policy.setBy, "owner");

  // An unverified identity is denied linking while the gate is on.
  const agent = f.store.identities.create("Gated agent");
  assert.throws(
    () => f.store.identities.link(ownerKey, "commons", { identityId: agent.identityId, permissions: ["accept_work"] }),
    err => err.code === "unverified_identity");
  assert.equal(
    await errorCode(await post(origin, "/api/rooms/commons/identity-links",
      { identityId: agent.identityId, permissions: ["accept_work"] }, ownerKey)),
    "unverified_identity");

  // After a room-owner attestation the same identity links cleanly.
  const attester = makeAttester(f);
  await post(origin, `/api/agent-identities/${agent.identityId}/verify`, {}, attester.secret);
  const linked = f.store.identities.link(ownerKey, "commons", { identityId: agent.identityId, permissions: ["accept_work"] });
  assert.equal(linked.memberId, agent.identityId);

  // Relaxing the policy re-opens linking for unverified identities.
  await post(origin, policyPath, { requireVerified: false }, ownerKey);
  const other = f.store.identities.create("Ungated agent");
  const linked2 = f.store.identities.link(ownerKey, "commons", { identityId: other.identityId, permissions: ["accept_work"] });
  assert.equal(linked2.memberId, other.identityId);
});

test("verification attestations survive a store reload", async t => {
  const f = createAcceptanceFixture();
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Reload agent");
  f.store.agentPlugin.verifyIdentity({ identityId: agent.identityId, verifiedBy: attester.identityId });
  f.store.agentPlugin.setRoomVerificationPolicy({ roomId: "commons", requireVerified: true, setBy: "owner" });
  const before = f.store.agentPlugin.verificationAttestation(agent.identityId);
  assert.equal(before.level, "verified");
  assert.equal(f.store.agentPlugin.roomVerificationPolicy("commons").requireVerified, true);
  // Rehydrate the plug-in store from the same SQLite file.
  f.store.agentPlugin.load();
  assert.deepEqual(f.store.agentPlugin.verificationAttestation(agent.identityId), before);
  assert.equal(f.store.agentPlugin.roomVerificationPolicy("commons").requireVerified, true);
  f.store.close();
});
