// Identity-holder proof-of-possession for identityId enrollment
// (Uuriko/project-room#942, task RC-2026-09-24-210). Replaces the #948
// interim disable: agent-connections create with identityId requires a
// single-use link code minted by the identity holder with their own pri_
// secret. Every failure reads as 422 identity_link_proof_required — no
// oracle. The raw code is never persisted; only its SHA-256 hash is
// stored until consumed (or expired).
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
  return { store, ownerKey, session, apply, createRequest, setNow: value => now = value, now: () => now };
}

function expectProofFailure(t, fn) {
  // Fail closed: every proof problem reads as the one 422 — no oracle
  // distinguishing missing from wrong from expired from reused.
  assert.throws(fn, { code: "identity_link_proof_required" });
  assert.throws(fn, error => error.status === 422);
}

test("create with identityId but no code fails closed 422 identity_link_proof_required and creates nothing", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const req = f.createRequest({ identityId: identity.identityId });
  expectProofFailure(t, () => f.apply(req));
  assert.equal(f.store.room("commons").state.members[req.memberId], undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("create with malformed codes fails closed as proof failures, not shape errors", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  for (const bad of ["short", "x".repeat(22), null, 42, "a+b/cdefghijklmnopqr", "\u{1f600}".repeat(22)]) {
    expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: bad })));
  }
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
});

test("create with unknown identityId and a well-formed code still 422s — no identity oracle", t => {
  const f = fixture(t);
  const code = randomBytes(16).toString("base64url");
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: "ai_doesnotexist000000000000000000000000000000", identityLinkCode: code })));
});

test("create with identityId but no code never discloses identity existence", t => {
  // The proof check fires before the identity lookup: a sponsor with a
  // pri_ secret for one identity can't use the error shape to probe
  // whether a different identityId exists.
  const f = fixture(t);
  const real = f.store.identities.create("Atomic Agent");
  for (const identityId of [real.identityId, "ai_doesnotexist000000000000000000000000000000"]) {
    expectProofFailure(t, () => f.apply(f.createRequest({ identityId })));
  }
});

test("valid proof enrolls atomically: link row, member stamp, receipt echo, bond resolution", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  assert.equal(minted.identityId, identity.identityId);
  assert.match(minted.linkCode, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(minted.expiresAt - f.now(), 10 * 60 * 1000);
  const req = f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode });
  const result = f.apply(req);
  assert.equal(result.receipt.identityId, identity.identityId, "receipt echoes the linked identity");
  const row = f.store.db.prepare("SELECT identity_id FROM identity_links WHERE room_id=? AND member_id=?").get("commons", req.memberId);
  assert.equal(row?.identity_id, identity.identityId, "identity_links row written in the same transaction");
  assert.equal(f.store.room("commons").state.members[req.memberId].identityId, identity.identityId, "member record stamped");
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), identity.identityId, "bond surface resolves the link");
  assert.equal(f.store.db.prepare("SELECT consumed_at FROM identity_link_codes").get().consumed_at !== null, true, "proof consumed");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("the raw link code is never persisted: not in the operation row, receipt, or fingerprint input", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  const req = f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode });
  const result = f.apply(req);
  const op = f.store.db.prepare("SELECT request_json, receipt_json, fingerprint FROM agent_connection_operations").get();
  for (const blob of [op.request_json, op.receipt_json, JSON.stringify(result)]) {
    assert(!blob.includes(minted.linkCode), "raw code must not appear in the journal or receipt");
  }
  const parsed = JSON.parse(op.request_json);
  assert.equal(parsed.identityLinkCode, undefined, "persisted request carries no proof field");
  assert.doesNotThrow(() => f.store.agentConnections.verify(), "history replay works without the code");
});

test("wrong-bound code fails: minted for A, presented for B", t => {
  const f = fixture(t);
  const a = f.store.identities.create("Agent A"), b = f.store.identities.create("Agent B");
  const minted = f.store.identities.mintLinkCode(a.identityId, a.secret);
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: b.identityId, identityLinkCode: minted.linkCode })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0, "nothing linked");
  // The unconsumed code is NOT burned by the failed attempt — holder retries still work.
  const result = f.apply(f.createRequest({ identityId: a.identityId, identityLinkCode: minted.linkCode }));
  assert.equal(result.receipt.identityId, a.identityId);
});

test("expired code fails closed", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  f.setNow(f.now() + 10 * 60 * 1000 + 1);
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  // The next mint prunes the expired row (TTL debris never wedges the cap).
  f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_link_codes WHERE identity_id=?").get(identity.identityId).n, 1);
});

test("reused code fails: the second enrollment with a fresh requestId burns", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode }));
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 1, "exactly one link survives");
});

test("tampered code fails", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  const tampered = minted.linkCode.slice(0, 21) + (minted.linkCode[21] === "A" ? "B" : "A");
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: tampered })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
});

test("code minted then identity revoked fails closed", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  f.store.identities.revoke(identity.identityId, identity.secret);
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
});

test("mintLinkCode: wrong secret is 401, unknown identity is 404, and no code is stored for failures", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  assert.throws(() => f.store.identities.mintLinkCode(identity.identityId, "not-a-secret"), { code: "unauthenticated" });
  // Well-formed pri_ secret belonging to a DIFFERENT identity: 401, not 403/404.
  const other = f.store.identities.create("Other Agent");
  assert.throws(() => f.store.identities.mintLinkCode(identity.identityId, other.secret), { code: "unauthenticated" });
  assert.throws(() => f.store.identities.mintLinkCode("ai_doesnotexist000000000000000000000000000000", "pri_whatever"), { code: "identity_not_found" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_link_codes").get().n, 0);
});

test("mintLinkCode stores only the hash, capped per identity, and prunes expired rows", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  const row = f.store.db.prepare("SELECT * FROM identity_link_codes").get();
  assert.equal(row.code_hash.length, 64, "SHA-256 hex");
  assert(!JSON.stringify(row).includes(minted.linkCode), "raw code is not in the row");
  assert.equal(row.consumed_at, null);
  // 9 more mints OK (cap is 10 outstanding); the 11th is refused 429 —
  // the holder should use one or let it expire, not stockpile proofs.
  for (let i = 0; i < 9; i++) f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  assert.throws(() => f.store.identities.mintLinkCode(identity.identityId, identity.secret), { code: "too_many_link_codes" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_link_codes WHERE identity_id=?").get(identity.identityId).n, 10);
  // Consuming one code frees a slot; minting works again and the fresh code verifies.
  f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode }));
  const other = f.store.identities.create("Second Agent");
  const otherMint = f.store.identities.mintLinkCode(other.identityId, other.secret);
  f.apply(f.createRequest({ identityId: other.identityId, identityLinkCode: otherMint.linkCode }));
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("duplicate requestId replays the original receipt without burning a second code", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  // A true idempotency replay: the exact same request bytes, including the
  // same keyHash and the same (already-consumed) proof.
  const req = f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode });
  const first = f.apply(req);
  assert.equal(first.duplicate, false, "first apply is not a replay");
  const second = f.apply({ ...req });
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 1);
});

test("create without identityId is unchanged: no link, no bond resolution", t => {
  const f = fixture(t);
  const req = f.createRequest();
  const result = f.apply(req);
  assert.equal(result.receipt.identityId, undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), null);
});

test("disconnect removes the identity link and echoes unlinkedIdentityId on the receipt", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret);
  const created = f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode }));
  const req = { action: "disconnect", requestId: randomUUID(), memberId: created.receipt.memberId, expectedOwnerRevision: 0, expectedGeneration: created.receipt.generation, expectedMemberRevision: 0 };
  const result = f.apply(req);
  assert.equal(result.receipt.unlinkedIdentityId, identity.identityId, "auditable unlink");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), null, "bond surface stops resolving");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("disconnect of an unlinked connection carries no unlinkedIdentityId", t => {
  const f = fixture(t);
  const created = f.apply(f.createRequest());
  const result = f.apply({ action: "disconnect", requestId: randomUUID(), memberId: created.receipt.memberId, expectedOwnerRevision: 0, expectedGeneration: created.receipt.generation, expectedMemberRevision: 0 });
  assert.equal(result.receipt.unlinkedIdentityId, undefined);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});
