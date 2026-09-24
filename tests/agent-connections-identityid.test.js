// RC-2026-09-24-209: interim #942 fix — identityId on agent-connections
// create is rejected (422, fail-closed) until the identity holder can prove
// possession in the same step. Create without identityId is unchanged.
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

test("create with identityId is rejected 422 and creates nothing (fail-closed)", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Disabled Link Agent");
  const req = f.createRequest({ identityId: identity.identityId });
  assert.throws(() => f.apply(req), err => {
    assert.equal(err.status, 422);
    assert.equal(err.code, "identity_link_disabled");
    assert.match(err.message, /proof-of-possession/);
    assert.match(err.message, /#942/);
    return true;
  });
  // Nothing landed: no membership, no connection row, no identity link.
  assert.equal(f.store.room("commons").state.members[req.memberId], undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
});

test("create with a malformed or unknown identityId is also rejected 422 at validation", t => {
  const f = fixture(t);
  // Malformed ids fail the format check first; well-formed-but-unknown ids hit the disable gate.
  assert.throws(() => f.apply(f.createRequest({ identityId: "not an id!!" })), { code: "invalid_connection" });
  assert.throws(() => f.apply(f.createRequest({ identityId: "ai_doesnotexist000000000000000000000000000000" })), { code: "identity_link_disabled" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
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
