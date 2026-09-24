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
  const key = secret();
  const apply = (body, token = session.token, binding = session.session.sessionBinding) => store.agentConnections.apply(token, "commons", body, binding);
  const createRequest = (extra = {}) => ({ action: "create", requestId: randomUUID(), memberId: `agent-${randomUUID()}`, displayName: "My assistant", access: "chat", keyHash: secret().keyHash, expiresAt: now + 3600000, expectedOwnerRevision: 0, ...extra });
  return { store, ownerKey, session, key, apply, createRequest, setNow: value => now = value };
}

test("create with identityId links the identity atomically: membership, credential and link land together", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const req = f.createRequest({ identityId: identity.identityId });
  const result = f.apply(req);
  assert.equal(result.duplicate, false);
  assert.equal(result.receipt.identityId, identity.identityId);
  const link = f.store.db.prepare("SELECT * FROM identity_links WHERE room_id=? AND identity_id=?").get("commons", identity.identityId);
  assert.ok(link, "identity_links row exists");
  assert.equal(link.member_id, req.memberId);
  // The member record carries the identity id in room state (self-describing).
  assert.equal(f.store.room("commons").state.members[req.memberId].identityId, identity.identityId);
  // The bond surface resolves the new member to its identity — no identity_required.
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), identity.identityId);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("create without identityId is unchanged: no link, no bond resolution", t => {
  const f = fixture(t);
  const req = f.createRequest();
  const result = f.apply(req);
  assert.equal(result.receipt.identityId, undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), null);
});

test("create with unknown identityId fails 404 and creates nothing (atomic rollback)", t => {
  const f = fixture(t);
  const req = f.createRequest({ identityId: "ai_doesnotexist000000000000000000000000000000" });
  assert.throws(() => f.apply(req), { code: "identity_not_found" });
  assert.equal(f.store.room("commons").state.members[req.memberId], undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
});

test("create with malformed identityId fails 422 at validation", t => {
  const f = fixture(t);
  assert.throws(() => f.apply(f.createRequest({ identityId: "not an id!!" })), { code: "invalid_connection" });
  assert.throws(() => f.apply(f.createRequest({ identityId: 42 })), { code: "invalid_connection" });
});

test("create with an already-linked identity fails 409 and creates nothing", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Linked Agent");
  const first = f.apply(f.createRequest({ identityId: identity.identityId }));
  assert.equal(first.receipt.identityId, identity.identityId);
  const req = f.createRequest({ identityId: identity.identityId });
  assert.throws(() => f.apply(req), { code: "identity_already_linked" });
  assert.equal(f.store.room("commons").state.members[req.memberId], undefined);
});

test("disconnect removes the identity link so the identity cannot keep using bonds", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Leaving Agent");
  const req = f.createRequest({ identityId: identity.identityId });
  f.apply(req);
  assert.ok(f.store.db.prepare("SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?").get("commons", identity.identityId));
  f.apply({ action: "disconnect", requestId: randomUUID(), memberId: req.memberId, expectedOwnerRevision: 0, expectedGeneration: 1, expectedMemberRevision: 0 });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), null);
});

test("idempotency: same requestId with same identityId duplicates; different identityId conflicts", t => {
  const f = fixture(t);
  const a = f.store.identities.create("Agent A"), b = f.store.identities.create("Agent B");
  const req = f.createRequest({ identityId: a.identityId });
  const first = f.apply(req);
  const retry = f.apply(req);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.receipt, first.receipt);
  assert.throws(() => f.apply({ ...req, identityId: b.identityId }), { code: "idempotency_conflict" });
});
