import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Interim disable (Uuriko/project-room#942): the identityId link path on
// agent-connections create is rejected outright until enrollment requires
// identity-holder proof-of-possession. These tests pin the disabled
// behavior: any create carrying identityId 422s and creates nothing,
// while creates without it behave exactly as before #931.

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

test("create with identityId is rejected 422 identity_link_disabled and creates nothing", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const req = f.createRequest({ identityId: identity.identityId });
  assert.throws(() => f.apply(req), { code: "identity_link_disabled" });
  assert.equal(f.store.room("commons").state.members[req.memberId], undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
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

test("create with unknown identityId is rejected 422 identity_link_disabled, not 404", t => {
  const f = fixture(t);
  const req = f.createRequest({ identityId: "ai_doesnotexist000000000000000000000000000000" });
  // The disable fires before the existence check — no identity oracle.
  assert.throws(() => f.apply(req), { code: "identity_link_disabled" });
  assert.equal(f.store.room("commons").state.members[req.memberId], undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
});

test("create with malformed identityId still fails 422 at validation", t => {
  const f = fixture(t);
  assert.throws(() => f.apply(f.createRequest({ identityId: "not an id!!" })), { code: "invalid_connection" });
  assert.throws(() => f.apply(f.createRequest({ identityId: 42 })), { code: "invalid_connection" });
});

test("create with an already-linked identity is rejected 422 identity_link_disabled", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Linked Agent");
  // Simulate a link created before the disable.
  f.store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?, ?, ?, ?)")
    .run("commons", identity.identityId, "some-member", Date.now());
  const req = f.createRequest({ identityId: identity.identityId });
  assert.throws(() => f.apply(req), { code: "identity_link_disabled" });
  assert.equal(f.store.room("commons").state.members[req.memberId], undefined);
});

test("disconnect still removes a pre-existing identity link", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Leaving Agent");
  const req = f.createRequest();
  f.apply(req);
  f.store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?, ?, ?, ?)")
    .run("commons", identity.identityId, req.memberId, Date.now());
  assert.ok(f.store.db.prepare("SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?").get("commons", identity.identityId));
  f.apply({ action: "disconnect", requestId: randomUUID(), memberId: req.memberId, expectedOwnerRevision: 0, expectedGeneration: 1, expectedMemberRevision: 0 });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), null);
});

test("idempotency: create with identityId is rejected on first try and retry alike", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Agent A");
  const req = f.createRequest({ identityId: identity.identityId });
  assert.throws(() => f.apply(req), { code: "identity_link_disabled" });
  assert.throws(() => f.apply(req), { code: "identity_link_disabled" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
});
