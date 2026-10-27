// RC-2026-09-18-049 — agent identity verification tiers.
// Pure-module unit tests plus HTTP integration tests for the attestation
// routes, the room verification-policy gate, and the directory trust tier.
import test from "node:test";
import assert from "node:assert/strict";
import { createIdentityVerification, VERIFIED, UNVERIFIED } from "../server/identity-verification.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
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

// SECURITY-FIX C1: attestation provenance is binding — a standing
// attestation cannot be overwritten or withdrawn by a different attester.
const OTHER = "ai_otherAttester";

test("cross-attester verify is refused and the standing attestation survives", () => {
  const v = fresh();
  v.verify(AI, { verifiedBy: OWNER });
  assert.throws(() => v.verify(AI, { verifiedBy: OTHER }),
    err => err.code === "attestation_conflict" && err.status === 409);
  assert.equal(v.attestation(AI).verifiedBy, OWNER);
  // The attester of record may still refresh its own attestation.
  assert.equal(v.verify(AI, { verifiedBy: OWNER }).verifiedBy, OWNER);
});

test("unverify by a non-attester is refused; by the attester succeeds", () => {
  const v = fresh();
  v.verify(AI, { verifiedBy: OWNER });
  assert.throws(() => v.unverify(AI, { by: OTHER }),
    err => err.code === "not_attester" && err.status === 403);
  assert.equal(v.level(AI), VERIFIED);
  assert.deepEqual(v.unverify(AI, { by: OWNER }), { identityId: AI, level: UNVERIFIED });
  assert.equal(v.level(AI), UNVERIFIED);
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

// SECURITY-FIX C1: attestation is relationship-scoped — the target must be a
// linked member of a room the attester owns. Bind the target into "commons"
// (member id = identity id, the agent-link convention) so the fixture
// attester holds that relationship.
function linkIntoCommons(f, identityId) {
  f.store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
    .run("commons", identityId, identityId, Date.now());
}

// SECURITY-FIX-2 TM-1: an attester confers the verified tier only when it
// is ANCHORED — its standing reaches outside the (attester, target) pair.
// Settlement leg: insert a PAID bounty in "commons" whose poster is the
// attester's commons member ("owner", the makeAttester binding) and whose
// claimant is a third identity linked into commons — a distinct operator
// outside any pair the attester attests into.
let anchorSeq = 0;
function anchorAttesterBySettlement(f) {
  const outsider = f.store.identities.create("Outside operator");
  linkIntoCommons(f, outsider.identityId);
  anchorSeq += 1;
  f.store.db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, claimant, state, state_changed_ms, deadline_ms, created_at, updated_at)
    VALUES (?, 'commons', 'anchor settlement', 'work done', 5000, 'owner', ?, 'paid', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
    .run(`b_anchor_${anchorSeq}`, outsider.identityId);
  return outsider;
}

test("attestation flow: verify -> read -> unverify -> read", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Working agent");
  linkIntoCommons(f, agent.identityId);

  const verifyRes = await post(origin, `/api/agent-identities/${agent.identityId}/verify`, {}, attester.secret);
  assert.equal(verifyRes.status, 201);
  const record = await verifyRes.json();
  assert.equal(record.level, "verified");
  assert.equal(record.verifiedBy, attester.identityId);
  assert.ok(typeof record.verifiedAt === "number");
  // TM-1: the fixture attester is unanchored (no settlement outside the
  // pair, nobody outside the pair attests it), so the attestation is
  // recorded as provenance but confers no tier.
  assert.equal(record.anchored, false);
  assert.equal(record.effectiveLevel, "unverified");

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

test("attestation requires a relationship; revocation requires the attester", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Working agent");
  const bystander = f.store.identities.create("Bystander");
  const path = `/api/agent-identities/${agent.identityId}/verify`;

  assert.equal((await post(origin, path, {})).status, 401);
  // A bystander owns no room and has no relationship with the target.
  assert.equal(await errorCode(await post(origin, path, {}, bystander.secret)), "no_attestation_relationship");
  // A room owner with no relationship to the target is refused identically:
  // ownership is free, so it cannot be the attestation authority.
  const unrelatedOwner = makeAttester(f);
  assert.equal(await errorCode(await post(origin, path, {}, unrelatedOwner.secret)), "no_attestation_relationship");
  // Revoking a non-existent attestation still requires room ownership.
  assert.equal(await errorCode(await del(origin, path, bystander.secret)), "not_room_owner");
  // Scoped keys are not the owner secret.
  const scoped = await (await post(origin, "/api/agent-keys", { scopes: ["directory:read"] }, bystander.secret)).json();
  assert.equal(await errorCode(await post(origin, path, {}, scoped.credential)), "insufficient_scope");
});

// SECURITY-FIX C1 door test — the HUNT-ADVERSARY R2 repro, inverted.
// Pre-fix every step below succeeded for the attacker: a self-bootstrapped
// owner verified an unrelated Sybil, and a second self-bootstrapped owner
// stripped the attestation. Post-fix each abuse is refused, while the
// legitimate path (attest a member of your own room; the attester of
// record withdraws) keeps working.
test("R2 inverted: self-bootstrapped owners cannot forge or strip attestations", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const rooms = new AgentRooms(f.store);
  const A = f.store.identities.create("Attacker A");
  const B = f.store.identities.create("Attacker B");
  const C = f.store.identities.create("Carol");
  const S = f.store.identities.create("Sybil S");
  const V = f.store.identities.create("Victim V");
  rooms.create(A.secret, { title: "A room", purpose: "test", starter: false, roomId: "a-room" });
  rooms.create(B.secret, { title: "B room", purpose: "test", starter: false, roomId: "b-room" });
  rooms.create(C.secret, { title: "C room", purpose: "test", starter: false, roomId: "c-room" });
  const verifyPath = id => `/api/agent-identities/${id}/verify`;

  // Ownership alone is not authority: A cannot verify its unrelated Sybil,
  // cannot verify itself, and B cannot verify the unrelated victim.
  assert.equal(await errorCode(await post(origin, verifyPath(S.identityId), {}, A.secret)), "no_attestation_relationship");
  assert.equal(await errorCode(await post(origin, verifyPath(A.identityId), {}, A.secret)), "no_attestation_relationship");
  assert.equal(await errorCode(await post(origin, verifyPath(V.identityId), {}, B.secret)), "no_attestation_relationship");
  assert.equal(f.store.agentPlugin.verificationLevel(S.identityId), "unverified");

  // The legitimate path: S joins A's room, then A attests S.
  const aKey = f.store.issueAccessKey("a-room", A.identityId);
  f.store.identities.link(aKey, "a-room", { identityId: S.identityId, permissions: ["accept_work"] });
  const ok = await post(origin, verifyPath(S.identityId), {}, A.secret);
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).verifiedBy, A.identityId);

  // B — a different self-bootstrapped owner — cannot strip A's attestation.
  assert.equal(await errorCode(await del(origin, verifyPath(S.identityId), B.secret)), "not_attester");
  assert.equal(f.store.agentPlugin.verificationAttestation(S.identityId).verifiedBy, A.identityId);
  // TM-1: A's attestation STANDS as provenance, but A is an unanchored
  // ring member (no standing outside the pair), so it confers no tier —
  // this is exactly the ring C1 left standing and TM-1 closes.
  assert.equal(f.store.agentPlugin.verificationLevel(S.identityId), "unverified");

  // C holds a relationship too (S is a member of C's room), but a standing
  // attestation is not silently overwritten: C gets 409 until A withdraws.
  const cKey = f.store.issueAccessKey("c-room", C.identityId);
  f.store.identities.link(cKey, "c-room", { identityId: S.identityId, permissions: ["accept_work"] });
  const conflict = await post(origin, verifyPath(S.identityId), {}, C.secret);
  assert.equal(conflict.status, 409);
  assert.equal(await errorCode(conflict), "attestation_conflict");
  assert.equal(f.store.agentPlugin.verificationAttestation(S.identityId).verifiedBy, A.identityId);

  // The attester of record withdraws; only then can C attest.
  assert.equal((await del(origin, verifyPath(S.identityId), A.secret)).status, 200);
  assert.equal((await post(origin, verifyPath(S.identityId), {}, C.secret)).status, 201);
  assert.equal(f.store.agentPlugin.verificationAttestation(S.identityId).verifiedBy, C.identityId);
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

  linkIntoCommons(f, agent.identityId);
  // TM-1: the card only surfaces "verified" when the attester is anchored;
  // give the fixture attester a paid settlement with an outside operator.
  anchorAttesterBySettlement(f);
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

  // After a room-owner attestation the same identity links cleanly. C1:
  // attestation is relationship-scoped, so the attester first meets the
  // agent in a room the attester owns (the agent joins the attester's own
  // room, which carries no verification gate), attests it there, and the
  // global tier then admits it to the gated room.
  const attester = makeAttester(f);
  // TM-1: the gate reads the CONFERRED tier, so the attester must be
  // anchored — a paid settlement with an operator outside the pair.
  anchorAttesterBySettlement(f);
  const rooms = new AgentRooms(f.store);
  rooms.create(attester.secret, { title: "Attester room", purpose: "test", starter: false, roomId: "attester-room" });
  const attesterKey = f.store.issueAccessKey("attester-room", attester.identityId);
  f.store.identities.link(attesterKey, "attester-room", { identityId: agent.identityId, permissions: ["accept_work"] });
  await post(origin, `/api/agent-identities/${agent.identityId}/verify`, {}, attester.secret);
  assert.equal(f.store.agentPlugin.verificationLevel(agent.identityId), "verified");
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

// ------------------------------------------------------------------
// SECURITY-FIX-2 TM-1 (Jill's anchor ruling): an attestation counts ONLY
// when the attester is itself anchored — ≥1 paid settlement with a
// DISTINCT operator outside the (attester, target) pair. (The ruling's
// "or operator-verified" leg is unimplemented by design — no operator-
// verification register exists; see the SF2-TM1-FIXUP tests below.)
// Unanchored attestations are recorded but confer nothing:
// verificationLevel reads "unverified", and every requireVerified gate
// inherits that through verificationLevel.
// ------------------------------------------------------------------

test("TM-1: a two-identity ring's attestation is recorded but confers nothing", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const rooms = new AgentRooms(f.store);
  const A = f.store.identities.create("Ring A");
  const B = f.store.identities.create("Ring B");
  rooms.create(A.secret, { title: "Ring room", purpose: "test", starter: false, roomId: "ring-room" });
  const aKey = f.store.issueAccessKey("ring-room", A.identityId);
  f.store.identities.link(aKey, "ring-room", { identityId: B.identityId, permissions: ["accept_work"] });

  // C1's relationship test passes (A owns the room B joined) — the
  // attestation is recorded…
  const res = await post(origin, `/api/agent-identities/${B.identityId}/verify`, {}, A.secret);
  assert.equal(res.status, 201);
  const attestation = f.store.agentPlugin.verificationAttestation(B.identityId);
  assert.equal(attestation.verifiedBy, A.identityId);
  assert.equal(attestation.anchored, false);
  // …but the ring's entire trust root is itself, so it confers nothing.
  assert.equal(f.store.agentPlugin.verificationLevel(B.identityId), "unverified");

  // And the strengthened gate refuses B where requireVerified is set.
  f.store.agentPlugin.setRoomVerificationPolicy({ roomId: "commons", requireVerified: true, setBy: "owner" });
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  assert.throws(
    () => f.store.identities.link(ownerKey, "commons", { identityId: B.identityId, permissions: ["accept_work"] }),
    err => err.code === "unverified_identity");
});

test("TM-1: a settlement INSIDE the pair does not anchor the attester", () => {
  const f = createAcceptanceFixture();
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Pair agent");
  linkIntoCommons(f, agent.identityId);
  // The attester's only paid settlement is WITH the target itself
  // (poster = attester's commons member, claimant = the target).
  f.store.db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, claimant, state, state_changed_ms, deadline_ms, created_at, updated_at)
    VALUES ('b_pair_only', 'commons', 'pair settlement', 'work done', 5000, 'owner', ?, 'paid', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
    .run(agent.identityId);
  f.store.agentPlugin.verifyIdentity({ identityId: agent.identityId, verifiedBy: attester.identityId });
  assert.equal(f.store.agentPlugin.attesterAnchored(attester.identityId, agent.identityId), false);
  assert.equal(f.store.agentPlugin.verificationLevel(agent.identityId), "unverified");
  f.store.close();
});

test("TM-1: an attester with a paid settlement outside the pair anchors", () => {
  const f = createAcceptanceFixture();
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Anchored agent");
  linkIntoCommons(f, agent.identityId);
  anchorAttesterBySettlement(f);
  f.store.agentPlugin.verifyIdentity({ identityId: agent.identityId, verifiedBy: attester.identityId });
  const attestation = f.store.agentPlugin.verificationAttestation(agent.identityId);
  assert.equal(attestation.anchored, true);
  assert.equal(attestation.effectiveLevel, "verified");
  assert.equal(f.store.agentPlugin.verificationLevel(agent.identityId), "verified");
  f.store.close();
});

test("TM-1 fixup: an attester attested from outside the pair does NOT anchor on vouching alone", () => {
  const f = createAcceptanceFixture();
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Vouched-only agent");
  linkIntoCommons(f, agent.identityId);
  // A third party (outside the pair) attests the attester. Under the
  // shipped operator leg that vouching anchored the attester; under
  // Jill's 2026-10-18 ruling it confers nothing — no operator-
  // verification register exists, so vouching is not "operator-
  // verified", and only a paid settlement anchors.
  const outside = f.store.identities.create("Outside attester");
  f.store.agentPlugin.verifyIdentity({ identityId: attester.identityId, verifiedBy: outside.identityId });
  f.store.agentPlugin.verifyIdentity({ identityId: agent.identityId, verifiedBy: attester.identityId });
  assert.equal(f.store.agentPlugin.attesterAnchored(attester.identityId, agent.identityId), false);
  assert.equal(f.store.agentPlugin.verificationLevel(agent.identityId), "unverified");
  f.store.close();
});

test("TM-1: a revoked attester anchors nothing, even with settlement history", () => {
  const f = createAcceptanceFixture();
  const attester = makeAttester(f);
  const agent = f.store.identities.create("Revoked-attester agent");
  linkIntoCommons(f, agent.identityId);
  anchorAttesterBySettlement(f);
  f.store.agentPlugin.verifyIdentity({ identityId: agent.identityId, verifiedBy: attester.identityId });
  assert.equal(f.store.agentPlugin.verificationLevel(agent.identityId), "verified");
  // The attester's identity is revoked: its attestation remains on record
  // as provenance but a departed attester confers nothing.
  f.store.db.prepare("UPDATE agent_identities SET revoked_at=? WHERE identity_id=?")
    .run(Date.now(), attester.identityId);
  assert.equal(f.store.agentPlugin.verificationAttestation(agent.identityId).verifiedBy, attester.identityId);
  assert.equal(f.store.agentPlugin.verificationLevel(agent.identityId), "unverified");
  f.store.close();
});

// SF2-TM1-FIXUP (Jill's ruling, 2026-10-18): the shipped TM-1 "operator
// leg" — an attester anchored merely by being attested from outside the
// pair — does NOT stand. No platform-operator verification register
// exists, so "operator-verified" has no product referent; anchoring is
// the paid-settlement leg ONLY. An attestation-only 3-cycle must
// therefore confer nothing: each member's only standing is the ring's
// own vouching, with zero settlements anywhere.
test("TM-1 fixup: an attestation-only 3-cycle anchors nobody", () => {
  const f = createAcceptanceFixture();
  const A = f.store.identities.create("Cycle A");
  const B = f.store.identities.create("Cycle B");
  const C = f.store.identities.create("Cycle C");
  // The cycle: A attests B, B attests C, C attests A. No bounty
  // settlements exist in this fixture at all.
  f.store.agentPlugin.verifyIdentity({ identityId: B.identityId, verifiedBy: A.identityId });
  f.store.agentPlugin.verifyIdentity({ identityId: C.identityId, verifiedBy: B.identityId });
  f.store.agentPlugin.verifyIdentity({ identityId: A.identityId, verifiedBy: C.identityId });
  // Every attestation is recorded as provenance…
  assert.equal(f.store.agentPlugin.verificationAttestation(A.identityId).verifiedBy, C.identityId);
  assert.equal(f.store.agentPlugin.verificationAttestation(B.identityId).verifiedBy, A.identityId);
  assert.equal(f.store.agentPlugin.verificationAttestation(C.identityId).verifiedBy, B.identityId);
  // …but no member of the ring is anchored w.r.t. any other, and no
  // attestation in the cycle confers the verified tier.
  assert.equal(f.store.agentPlugin.attesterAnchored(A.identityId, B.identityId), false);
  assert.equal(f.store.agentPlugin.attesterAnchored(B.identityId, C.identityId), false);
  assert.equal(f.store.agentPlugin.attesterAnchored(C.identityId, A.identityId), false);
  assert.equal(f.store.agentPlugin.verificationLevel(A.identityId), "unverified");
  assert.equal(f.store.agentPlugin.verificationLevel(B.identityId), "unverified");
  assert.equal(f.store.agentPlugin.verificationLevel(C.identityId), "unverified");
  f.store.close();
});
