// RC-2026-09-24-210: proper #942 fix — identityId on agent-connections
// create requires identity-holder proof-of-possession (a single-use link
// code minted by the holder, POST /api/identities/{identityId}/link-code).
// Without a valid code the create is rejected (422
// identity_link_proof_required, fail-closed) before any identity lookup, so
// there is no identity oracle. Create without identityId is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function fixture(t) {
  let now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner"), session = store.createSession(ownerKey);
  const secret = () => { const token = randomBytes(32).toString("base64url"); return { token, keyHash: createHash("sha256").update(token).digest("hex") }; };
  const apply = (body, token = session.token, binding = session.session.sessionBinding) => store.agentConnections.apply(token, "commons", body, binding);
  const createRequest = (extra = {}) => ({ action: "create", requestId: randomUUID(), memberId: `agent-${randomUUID()}`, displayName: "My assistant", access: "chat", keyHash: secret().keyHash, expiresAt: now + 3600000, expectedOwnerRevision: 0, ...extra });
  return { store, apply, createRequest };
}

test("create with identityId but no link code is rejected 422 and creates nothing (fail-closed)", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Proof Link Agent");
  const req = f.createRequest({ identityId: identity.identityId });
  assert.throws(() => f.apply(req), err => {
    assert.equal(err.status, 422);
    assert.equal(err.code, "identity_link_proof_required");
    assert.match(err.message, /link code/);
    assert.match(err.message, /link-code/);
    return true;
  });
  // Nothing landed: no membership, no connection row, no identity link.
  assert.equal(f.store.room("commons").state.members[req.memberId], undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
});

test("create with a malformed or unknown identityId is also rejected 422 at validation", t => {
  const f = fixture(t);
  // Malformed ids fail the format check first; well-formed ids without a
  // valid proof hit the proof gate before any identity lookup (no oracle).
  assert.throws(() => f.apply(f.createRequest({ identityId: "not an id!!" })), { code: "invalid_connection" });
  assert.throws(() => f.apply(f.createRequest({ identityId: "ai_doesnotexist000000000000000000000000000000" })), { code: "identity_link_proof_required" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
});

test("create with an inherited object name is not treated as an existing member", t => {
  const f = fixture(t);
  assert.throws(() => f.apply(f.createRequest({ memberId: "constructor" })), err => err.code === "invalid_connection");
  const req = f.createRequest({ memberId: "toString" });
  const result = f.apply(req);
  assert.equal(result.duplicate, false);
  const member = f.store.room("commons").state.members.toString;
  assert.equal(member?.kind, "agent");
  assert.equal(member?.id, "toString");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections WHERE member_id=?").get("toString").n, 1);
});

test("create without identityId is unchanged: enrolls, no link, no identity echo", t => {
  const f = fixture(t);
  const req = f.createRequest();
  const result = f.apply(req);
  assert.equal(result.duplicate, false);
  assert.equal(result.receipt.identityId, undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), null);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("rotate without identityId still works (field is create-only)", t => {
  const f = fixture(t);
  const req = f.createRequest();
  f.apply(req);
  const rotated = f.apply({ action: "rotate", requestId: randomUUID(), memberId: req.memberId, expectedOwnerRevision: 0, expectedGeneration: 1, expectedMemberRevision: 0,
    keyHash: createHash("sha256").update(randomBytes(32)).digest("hex"), expiresAt: Date.now() + 7200000 });
  assert.equal(rotated.receipt.generation, 2);
});

// FIX-C5 (HUNT-ADVERSARY P5, Jill's ruling): rotation of an identity-linked
// connection may not take a sponsor-chosen key — the sponsor could
// thereafter authenticate AS the enrolled identity. Rotate must either
// server-generate the key (plaintext returned exactly once) or carry
// holder proof (the identity secret or a fresh single-use link code).
// Owner-created connections with no identity link are unchanged.
function linkedFixture(t) {
  const f = fixture(t);
  const identity = f.store.identities.create("Enrolled Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  const req = f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode });
  const created = f.apply(req);
  const rotateRequest = (extra = {}) => ({ action: "rotate", requestId: randomUUID(), memberId: req.memberId,
    expectedOwnerRevision: 0, expectedGeneration: created.receipt.generation, expectedMemberRevision: 0,
    expiresAt: Date.now() + 7200000, ...extra });
  const credentialHash = () => f.store.db.prepare("SELECT credential_hash FROM agent_connections WHERE member_id=?").get(req.memberId).credential_hash;
  return { ...f, identity, req, created, rotateRequest, credentialHash };
}

test("FIX-C5: owner-chosen keyHash on an identity-linked connection is refused and changes nothing", t => {
  const f = linkedFixture(t);
  const before = f.credentialHash();
  assert.throws(() => f.apply(f.rotateRequest({ keyHash: createHash("sha256").update(randomBytes(32)).digest("hex") })),
    err => err.status === 422 && err.code === "rotation_key_not_allowed");
  assert.equal(f.credentialHash(), before, "credential untouched");
  assert.equal(f.store.db.prepare("SELECT generation FROM agent_connections WHERE member_id=?").get(f.req.memberId).generation, 1);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("FIX-C5: holder proof by fresh link code lets the rotation proceed, and the code is single-use", t => {
  const f = linkedFixture(t);
  const keyHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const minted = f.store.identities.mintLinkCode(f.identity.identityId, f.identity.secret);
  const rotated = f.apply(f.rotateRequest({ keyHash, identityLinkCode: minted.linkCode }));
  assert.equal(rotated.receipt.generation, 2);
  assert.equal(rotated.receipt.serverGenerated, undefined);
  assert.equal(rotated.rotatedKey, undefined, "a caller-chosen key is never echoed back");
  assert.equal(f.credentialHash(), keyHash);
  // The burned code cannot authorize a second rotation.
  const next = { ...f.rotateRequest({ keyHash: createHash("sha256").update(randomBytes(32)).digest("hex"), identityLinkCode: minted.linkCode }),
    expectedGeneration: 2 };
  assert.throws(() => f.apply(next), err => err.status === 422 && err.code === "identity_link_proof_required");
  assert.equal(f.credentialHash(), keyHash, "failed proof changed nothing");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("FIX-C5: holder proof by identity secret works; a wrong secret is refused as a proof failure", t => {
  const f = linkedFixture(t);
  const keyHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const before = f.credentialHash();
  assert.throws(() => f.apply(f.rotateRequest({ keyHash, identitySecret: "ai_wrong_secret_value" })),
    err => err.status === 422 && err.code === "identity_link_proof_required");
  assert.equal(f.credentialHash(), before, "failed proof changed nothing");
  const rotated = f.apply(f.rotateRequest({ keyHash, identitySecret: f.identity.secret }));
  assert.equal(rotated.receipt.generation, 2);
  assert.equal(f.credentialHash(), keyHash);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("FIX-C5: server-generated rotate returns the key exactly once and the journal still verifies", t => {
  const f = linkedFixture(t);
  const oldHash = f.credentialHash();
  const request = f.rotateRequest();
  const rotated = f.apply(request);
  assert.equal(typeof rotated.rotatedKey, "string");
  assert.equal(rotated.receipt.serverGenerated, true);
  assert.equal(f.credentialHash(), createHash("sha256").update(rotated.rotatedKey).digest("hex"),
    "the stored hash is the returned key's hash");
  assert.notEqual(f.credentialHash(), oldHash);
  assert.equal(f.store.db.prepare("SELECT revoked FROM credentials WHERE hash=?").get(oldHash).revoked, 1,
    "the old credential is revoked");
  // The new key authenticates as the member, end to end.
  const auth = f.store.authenticate(rotated.rotatedKey, "commons");
  assert.equal(auth.member.id, f.req.memberId);
  // A duplicate replay returns the receipt but never the key again.
  const replay = f.apply(request);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.rotatedKey, undefined);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("FIX-C5: a doomed rotation never burns the holder's link code", t => {
  const f = linkedFixture(t);
  const minted = f.store.identities.mintLinkCode(f.identity.identityId, f.identity.secret);
  const keyHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  // Stale generation: the request fails before the proof is consumed.
  const stale = { ...f.rotateRequest({ keyHash, identityLinkCode: minted.linkCode }), expectedGeneration: 99 };
  assert.throws(() => f.apply(stale), err => err.code === "connection_changed");
  const rotated = f.apply(f.rotateRequest({ keyHash, identityLinkCode: minted.linkCode }));
  assert.equal(rotated.receipt.generation, 2, "the same code still authorizes the corrected request");
});

test("FIX-C5: unlinked connections are unchanged — keyHash still required, owner-chosen still works", t => {
  const f = fixture(t);
  const req = f.createRequest();
  f.apply(req);
  const base = { action: "rotate", requestId: randomUUID(), memberId: req.memberId, expectedOwnerRevision: 0,
    expectedGeneration: 1, expectedMemberRevision: 0, expiresAt: Date.now() + 7200000 };
  assert.throws(() => f.apply(base), err => err.status === 422 && err.code === "invalid_connection",
    "server-generated rotate is not offered without an identity link");
  const keyHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const rotated = f.apply({ ...base, requestId: randomUUID(), keyHash });
  assert.equal(rotated.receipt.generation, 2);
  assert.equal(rotated.receipt.serverGenerated, undefined);
  assert.equal(rotated.rotatedKey, undefined);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});
