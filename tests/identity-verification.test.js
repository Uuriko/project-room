// RC-2026-09-18-049 — agent identity verification tiers.
// Pure-module unit tests plus HTTP integration tests for the attestation
// routes, the room verification-policy gate, and the directory trust tier.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentityVerification, VERIFIED, UNVERIFIED } from "../server/identity-verification.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

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

// ---- SEC2-C-B: unverify must not strip an attestation silently ----
//
// requireVerified was admission-only: any room owner could DELETE another
// owner's attestation and the member stayed seated, permissions and link
// intact, with no signal. Revocation now requires the original attester or
// a membership admin of a room where the identity is seated, and every
// revocation re-evaluates the seat: in rooms whose policy requires verified
// identities the member is suspended (deactivated, permissions preserved)
// in the same transaction.

async function seatedVerified(t) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Seated agent");
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  await post(origin, "/api/rooms/commons/verification-policy", { requireVerified: true }, ownerKey);
  await post(origin, `/api/agent-identities/${agent.identityId}/verify`, {}, attester.secret);
  f.store.identities.link(ownerKey, "commons", { identityId: agent.identityId, permissions: ["accept_work", "complete_work"] });
  return { f, origin, attester, agent, ownerKey };
}

test("SEC2-C-B: a caller with no standing cannot strip an attestation over HTTP", async t => {
  const { f, origin, agent } = await seatedVerified(t);
  const bystander = f.store.identities.create("Bystander");
  const res = await del(origin, `/api/agent-identities/${agent.identityId}/verify`, bystander.secret);
  assert.equal(res.status, 403);
  assert.equal(await errorCode(res), "not_attestation_owner");
  // Nothing moved: attestation, seat, permissions and link all survive.
  assert.equal(f.store.agentPlugin.verificationLevel(agent.identityId), "verified");
  const member = f.store.roomAuthority("commons").members[agent.identityId];
  assert.equal(member.active, true);
  assert.deepEqual(member.permissions, ["accept_work", "complete_work"]);
});

test("SEC2-C-B: the owner of an unrelated room cannot strip the attestation", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-sec2cb-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("annex"));
  const agent = store.identities.create("Guarded agent");
  const annexOwner = store.identities.create("Annex owner");
  const ownerCommons = store.issueAccessKey("commons", "owner");
  // The annex owner owns a room — the old route gate ("owns any room")
  // admitted exactly this caller — but has no standing over the seat.
  // (Direct link row to the seeded owner member, the makeAttester idiom.)
  store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
    .run("annex", annexOwner.identityId, "owner", Date.now());
  assert.equal(store.agentPlugin.isRoomOwner(annexOwner.identityId), true);
  store.agentPlugin.verifyIdentity({ identityId: agent.identityId, verifiedBy: "ai_attester" });
  store.agentPlugin.setRoomVerificationPolicy({ roomId: "commons", requireVerified: true, setBy: "owner" });
  store.identities.link(ownerCommons, "commons", { identityId: agent.identityId, permissions: ["accept_work"] });
  assert.throws(
    () => store.agentPlugin.unverifyIdentity({ identityId: agent.identityId, revokedBy: annexOwner.identityId }),
    err => err.code === "not_attestation_owner");
  assert.equal(store.agentPlugin.verificationLevel(agent.identityId), "verified");
  assert.equal(store.roomAuthority("commons").members[agent.identityId].active, true);
});

test("SEC2-C-B: the attester can unverify, and the gated seat is suspended in the same act", async t => {
  const { f, origin, attester, agent } = await seatedVerified(t);
  const res = await del(origin, `/api/agent-identities/${agent.identityId}/verify`, attester.secret);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.level, "unverified");
  assert.equal(body.revokedBy, attester.identityId);
  assert.deepEqual(body.suspendedRooms, ["commons"]);
  assert.equal(f.store.agentPlugin.verificationLevel(agent.identityId), "unverified");
  const member = f.store.roomAuthority("commons").members[agent.identityId];
  assert.equal(member.active, false, "seat in the verified-gated room is suspended");
  assert.deepEqual(member.permissions, ["accept_work", "complete_work"], "permissions are preserved on the suspended record, not stripped silently");
  const link = f.store.db.prepare("SELECT 1 FROM identity_links WHERE room_id='commons' AND identity_id=?").get(agent.identityId);
  assert.ok(link, "the identity link survives a suspension (reactivation stays possible)");
});

test("SEC2-C-B: a membership admin of the seated room (not the attester, owns no room) can unverify", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Guarded agent one");
  const admin = f.store.identities.create("Ana Souza");
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  // Link everyone before the gate goes on; then attest; then gate.
  f.store.identities.link(ownerKey, "commons", { identityId: admin.identityId, permissions: ["manage_members"] });
  f.store.identities.link(ownerKey, "commons", { identityId: agent.identityId, permissions: ["accept_work"] });
  await post(origin, `/api/agent-identities/${agent.identityId}/verify`, {}, attester.secret);
  await post(origin, "/api/rooms/commons/verification-policy", { requireVerified: true }, ownerKey);
  assert.equal(f.store.agentPlugin.isRoomOwner(admin.identityId), false);
  const res = await del(origin, `/api/agent-identities/${agent.identityId}/verify`, admin.secret);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.suspendedRooms, ["commons"]);
  assert.equal(f.store.roomAuthority("commons").members[agent.identityId].active, false);
});

test("SEC2-C-B: a membership-delegation grant holder can unverify", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Guarded agent two");
  const delegate = f.store.identities.create("Dario Fontana");
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  f.store.identities.link(ownerKey, "commons", { identityId: delegate.identityId, permissions: [] });
  f.store.identities.link(ownerKey, "commons", { identityId: agent.identityId, permissions: ["accept_work"] });
  await post(origin, `/api/agent-identities/${agent.identityId}/verify`, {}, attester.secret);
  await post(origin, "/api/rooms/commons/verification-policy", { requireVerified: true }, ownerKey);
  f.store.delegation.grant(ownerKey, "commons", { identityId: delegate.identityId });
  assert.equal(f.store.agentPlugin.isRoomOwner(delegate.identityId), false);
  const res = await del(origin, `/api/agent-identities/${agent.identityId}/verify`, delegate.secret);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).suspendedRooms, ["commons"]);
});

test("SEC2-C-B: caller-less system unverify (restore reconcile) still strips and suspends", async t => {
  const { f, agent } = await seatedVerified(t);
  const result = f.store.agentPlugin.unverifyIdentity({ identityId: agent.identityId });
  assert.equal(result.level, "unverified");
  assert.deepEqual(result.suspendedRooms, ["commons"]);
  assert.equal(f.store.roomAuthority("commons").members[agent.identityId].active, false);
});

test("SEC2-C-B: unverify suspends only verified-gated seats; other rooms are untouched", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-sec2cb-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("annex"));
  const agent = store.identities.create("Two-room agent");
  const ownerCommons = store.issueAccessKey("commons", "owner");
  const ownerAnnex = store.issueAccessKey("annex", "owner");
  store.agentPlugin.verifyIdentity({ identityId: agent.identityId, verifiedBy: "ai_attester" });
  store.agentPlugin.setRoomVerificationPolicy({ roomId: "commons", requireVerified: true, setBy: "owner" });
  store.identities.link(ownerCommons, "commons", { identityId: agent.identityId, permissions: ["accept_work"] });
  store.identities.link(ownerAnnex, "annex", { identityId: agent.identityId, permissions: ["accept_work"] });
  const result = store.agentPlugin.unverifyIdentity({ identityId: agent.identityId, revokedBy: "ai_attester" });
  assert.deepEqual(result.suspendedRooms, ["commons"]);
  assert.equal(store.roomAuthority("commons").members[agent.identityId].active, false);
  assert.equal(store.roomAuthority("annex").members[agent.identityId].active, true, "the non-gated seat never depended on the attestation");
});

test("SEC2-C-B: suspension is reversible — re-verify plus admin reactivation restores the seat", async t => {
  const { f, origin, attester, agent, ownerKey } = await seatedVerified(t);
  await del(origin, `/api/agent-identities/${agent.identityId}/verify`, attester.secret);
  assert.equal(f.store.roomAuthority("commons").members[agent.identityId].active, false);
  const reverify = await post(origin, `/api/agent-identities/${agent.identityId}/verify`, {}, attester.secret);
  assert.equal(reverify.status, 201);
  const member = f.store.roomAuthority("commons").members[agent.identityId];
  f.store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: agent.identityId, expectedMemberRevision: member.revision, permissions: member.permissions, active: true } });
  assert.equal(f.store.roomAuthority("commons").members[agent.identityId].active, true);
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
