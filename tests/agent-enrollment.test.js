import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { auditRecovery } from "../server/recovery.mjs";

function fixture(t) {
  let now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now }); store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner"), session = store.createSession(ownerKey);
  const secret = () => { const token = randomBytes(32).toString("base64url"); return { token, keyHash: createHash("sha256").update(token).digest("hex") }; };
  const key = secret();
  const request = { action: "create", requestId: randomUUID(), memberId: `agent-${randomUUID()}`, displayName: "My assistant", access: "chat", keyHash: key.keyHash, expiresAt: now + 3600000, expectedOwnerRevision: 0 };
  const apply = (body, token = session.token, binding = session.session.sessionBinding) => store.agentConnections.apply(token, "commons", body, binding);
  const change = (memberId, revision, extra = {}) => store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: { memberId, expectedMemberRevision: revision, active: true, permissions: [], ...extra } });
  return { store, ownerKey, session, secret, key, request, apply, change, setNow: value => now = value };
}

test("owner enrollment, rotation and disconnection retain exact original receipts without secrets or resurrection", t => {
  const f = fixture(t), first = f.apply(f.request), roomBeforeRotate = f.store.room("commons").sequence;
  assert.equal(first.connection.status, "key_issued");
  assert.deepEqual(f.store.authenticate(f.key.token).member.permissions, []);
  assert.equal(first.receipt.generation, 1);
  const next = f.secret(), rotate = { action: "rotate", requestId: randomUUID(), memberId: f.request.memberId, expectedOwnerRevision: 0, expectedGeneration: 1, expectedMemberRevision: 0, keyHash: next.keyHash, expiresAt: f.request.expiresAt };
  const second = f.apply(rotate);
  assert.equal(second.receipt.membershipEventId, null);
  assert.equal(f.store.room("commons").sequence, roomBeforeRotate);
  assert.throws(() => f.store.authenticate(f.key.token), { code: "unauthenticated" });
  assert.equal(f.store.authenticate(next.token).member.id, f.request.memberId);
  const disconnect = { action: "disconnect", requestId: randomUUID(), memberId: f.request.memberId, expectedOwnerRevision: 0, expectedGeneration: 2, expectedMemberRevision: 0 };
  const ended = f.apply(disconnect), sequence = f.store.room("commons").sequence;
  for (const [request, result] of [[f.request, first], [rotate, second], [disconnect, ended]]) {
    const retry = f.apply(request); assert.equal(retry.duplicate, true); assert.deepEqual(retry.receipt, result.receipt);
    assert.equal(retry.connection.status, "disconnected");
  }
  assert.equal(f.store.room("commons").sequence, sequence);
  assert.throws(() => f.store.authenticate(next.token), { code: "unauthenticated" });
  assert.throws(() => f.apply({ ...f.request, displayName: "Changed" }), { code: "idempotency_conflict" });
  const all = JSON.stringify([...f.store.db.prepare("SELECT * FROM agent_connection_operations").all(), ...f.store.db.prepare("SELECT * FROM events").all(), first]);
  assert.equal(all.includes(f.key.token), false); assert.equal(all.includes(next.token), false);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  assert.equal(auditRecovery(f.store).checks.agentConnections, true);
});

test("stale generation and member revisions fail atomically; ordinary key issuance cannot bypass managed access", t => {
  const f = fixture(t); f.apply(f.request);
  const before = auditRecovery(f.store).dataSha256;
  assert.throws(() => f.store.issueAccessKey("commons", f.request.memberId), { code: "managed_agent" });
  assert.equal(f.store.authenticate(f.key.token).member.id, f.request.memberId);
  assert.throws(() => f.apply({ action: "disconnect", requestId: randomUUID(), memberId: f.request.memberId, expectedOwnerRevision: 0, expectedGeneration: 2, expectedMemberRevision: 0 }), { code: "connection_changed" });
  assert.equal(auditRecovery(f.store).dataSha256, before);
  f.change(f.request.memberId, 0, { permissions: ["verify"] });
  assert.throws(() => f.store.authenticate(f.key.token), { code: "unauthenticated" });
  f.change(f.request.memberId, 1, { permissions: [] });
  assert.throws(() => f.store.authenticate(f.key.token), { code: "unauthenticated" });
  const key = f.secret();
  f.apply({ action: "rotate", requestId: randomUUID(), memberId: f.request.memberId, expectedOwnerRevision: 0, expectedGeneration: 1, expectedMemberRevision: 2, keyHash: key.keyHash, expiresAt: f.request.expiresAt });
  assert.equal(f.store.authenticate(key.token).member.revision, 2);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("sponsor changes end access permanently; browser logout alone does not", t => {
  const f = fixture(t); f.apply(f.request);
  f.store.revoke(f.session.token);
  assert.equal(f.store.authenticate(f.key.token).member.id, f.request.memberId);
  const permissions = f.store.room("commons").state.members.owner.permissions;
  f.change("owner", 0, { permissions });
  assert.throws(() => f.store.authenticate(f.key.token), { code: "unauthenticated" });
  f.change("owner", 1, { permissions });
  assert.throws(() => f.store.authenticate(f.key.token), { code: "unauthenticated" });
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("sponsor suspension and reactivation never revive a key; legacy agent keys remain separate", t => {
  const f = fixture(t); f.apply(f.request);
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "legacy-agent", displayName: "Legacy", kind: "agent", permissions: [] } });
  const legacyKey = f.store.issueAccessKey("commons", "legacy-agent");
  const account = f.store.authenticate(f.ownerKey).account;
  f.store.changeAccountAccess(account.id, { expectedRevision: 0, active: false, reason: "test" });
  assert.throws(() => f.store.authenticate(f.key.token), { code: "unauthenticated" });
  f.store.changeAccountAccess(account.id, { expectedRevision: 1, active: true, reason: "test" });
  assert.throws(() => f.store.authenticate(f.key.token), { code: "unauthenticated" });
  assert.equal(f.store.authenticate(legacyKey).member.id, "legacy-agent");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("real wall-clock steps and backward clock changes remain auditable; widened access can always be disconnected", t => {
  const f = fixture(t); let time = Date.now(); f.store.now = () => time++;
  f.apply(f.request); assert.doesNotThrow(() => f.store.agentConnections.verify());
  time -= 10000;
  const next = f.secret(); f.apply({ action: "rotate", requestId: randomUUID(), memberId: f.request.memberId, expectedOwnerRevision: 0,
    expectedGeneration: 1, expectedMemberRevision: 0, keyHash: next.keyHash, expiresAt: f.request.expiresAt });
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  f.change(f.request.memberId, 0, { permissions: ["write_external"] });
  assert.equal(f.apply({ action: "disconnect", requestId: randomUUID(), memberId: f.request.memberId, expectedOwnerRevision: 0,
    expectedGeneration: 2, expectedMemberRevision: 1 }).connection.status, "disconnected");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("a human manager is not the owner; account-browser owner sessions work and input types are exact", t => {
  const f = fixture(t);
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "manager", displayName: "Manager", kind: "human", permissions: ["manage_members"] } });
  const other = f.store.createSession(f.store.issueAccessKey("commons", "manager"));
  assert.throws(() => f.apply(f.request, other.token, other.session.sessionBinding), { code: "owner_required" });
  assert.throws(() => f.apply({ ...f.request, access: ["chat"] }), { code: "invalid_connection" });
  assert.throws(() => f.apply({ ...f.request, keyHash: [f.key.keyHash] }), { code: "invalid_connection" });
  const account = f.store.accountForMember("commons", "owner"), accessKey = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, accessKey, 0);
  assert.equal(f.apply(f.request, slot.token, session.sessionBinding).connection.status, "key_issued");
  assert.throws(() => f.apply(f.request, slot.token, "wrong"), { code: "session_binding_changed" });
});

test("only one competing generation replacement succeeds", t => {
  const f = fixture(t); f.apply(f.request);
  const make = () => ({ action: "rotate", requestId: randomUUID(), memberId: f.request.memberId, expectedOwnerRevision: 0,
    expectedGeneration: 1, expectedMemberRevision: 0, keyHash: f.secret().keyHash, expiresAt: f.request.expiresAt });
  const a = make(), b = make(); assert.equal(f.apply(a).receipt.generation, 2);
  const before = auditRecovery(f.store).dataSha256;
  assert.throws(() => f.apply(b), { code: "connection_changed" }); assert.equal(auditRecovery(f.store).dataSha256, before);
});

test("disconnecting an already inactive managed member records a terminal receipt without another membership event", t => {
  const f = fixture(t); f.apply(f.request);
  f.change(f.request.memberId, 0, { active: false });
  const sequence = f.store.room("commons").sequence;
  const request = { action: "disconnect", requestId: randomUUID(), memberId: f.request.memberId,
    expectedOwnerRevision: 0, expectedGeneration: 1, expectedMemberRevision: 1 };
  const result = f.apply(request);
  assert.equal(result.connection.status, "disconnected");
  assert.equal(result.receipt.membershipEventId, null);
  assert.equal(f.store.room("commons").sequence, sequence);
  const replay = f.apply(request);
  assert.equal(replay.duplicate, true); assert.deepEqual(replay.receipt, result.receipt);
  assert.throws(() => f.store.authenticate(f.key.token), { code: "unauthenticated" });
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  assert.equal(auditRecovery(f.store).checks.agentConnections, true);
});

test("capacity limits never prevent ending active access and do not permit reactivation", t => {
  const f = fixture(t); f.apply(f.request);
  const room = f.store.room.bind(f.store);
  // A synthetic capped view isolates both limits; it is not a recovery fixture.
  f.store.room = id => { const result = room(id); result.sequence = Math.max(10000, result.sequence);
    result.state.capacityFixture = "x".repeat(4 * 1024 * 1024); return result; };
  const request = { action: "disconnect", requestId: randomUUID(), memberId: f.request.memberId,
    expectedOwnerRevision: 0, expectedGeneration: 1, expectedMemberRevision: 0 };
  assert.equal(f.apply(request).connection.status, "disconnected");
  assert.throws(() => f.store.authenticate(f.key.token), { code: "unauthenticated" });
  assert.throws(() => f.change(f.request.memberId, 1, { active: true }), { code: "pilot_limit" });
  assert.equal(f.apply(request).duplicate, true);
});

test("owner browser authorization, digest-only input and expiry are required; late exact retry is safe", t => {
  const f = fixture(t);
  assert.throws(() => f.apply(f.request, f.ownerKey, null), { code: "owner_required" });
  assert.throws(() => f.apply(f.request, f.session.token, "wrong"), { code: "session_binding_changed" });
  assert.throws(() => f.apply({ ...f.request, token: f.key.token }), { code: "invalid_connection" });
  assert.throws(() => f.apply({ ...f.request, expiresAt: Date.now() + 31 * 86400000 }), { code: "invalid_expiry" });
  const skewed = f.apply({ ...f.request, requestId: randomUUID(), memberId: `agent-${randomUUID()}`,
    keyHash: f.secret().keyHash, expiresAt: f.store.now() + 30 * 86400000 + 30_000 });
  assert.equal(skewed.connection.status, "key_issued");
  const result = f.apply(f.request); f.setNow(f.request.expiresAt + 1);
  const retry = f.apply(f.request); assert.deepEqual(retry.receipt, result.receipt); assert.equal(retry.connection.status, "expired");
  assert.throws(() => f.store.authenticate(f.key.token), { code: "unauthenticated" });
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("failure after membership creation rolls back the entire grant", t => {
  const f = fixture(t), before = f.store.room("commons").sequence;
  f.store.db.exec("CREATE TRIGGER test_fail_grant BEFORE INSERT ON agent_connection_operations BEGIN SELECT RAISE(ABORT,'test storage failure'); END");
  assert.throws(() => f.apply(f.request), /test storage failure/);
  assert.equal(f.store.room("commons").sequence, before);
  assert.equal(f.store.room("commons").state.members[f.request.memberId], undefined);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_connections").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM credentials WHERE hash=?").get(f.key.keyHash).n, 0);
  f.store.db.exec("DROP TRIGGER test_fail_grant");
  assert.equal(f.apply(f.request).duplicate, false);
});

test("connection list surfaces the agent's first action so enrollment closes the loop", t => {
  const f = fixture(t); f.apply(f.request);
  const list = () => f.store.agentConnections.list(f.session.token, "commons", f.session.session.sessionBinding).connections;
  const before = list().find(row => row.memberId === f.request.memberId);
  assert.equal(before.status, "key_issued");
  assert.equal(before.firstActionAt, null);
  f.store.command(f.key.token, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "First check-in" } });
  const after = list().find(row => row.memberId === f.request.memberId);
  assert.equal(after.status, "key_issued");
  assert.equal(typeof after.firstActionAt, "string");
  assert.ok(!Number.isNaN(Date.parse(after.firstActionAt)));
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});
