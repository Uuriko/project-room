import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AccessRequests } from "../server/access-requests.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:"); store.initialize(initialRoom("commons"));
  const owner = store.issueAccessKey("commons", "owner"), access = new AccessRequests(store);
  const account = id => {
    store.createAccount(id); const key = store.issueAccountAccessKey(id), slot = store.createAccountSessionSlot();
    const session = store.loginAccountSession(slot.token, key, slot.session.sessionRevision);
    return { token: slot.token, session };
  };
  const alice = account("alice-account"), bob = account("bob-account");
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, who = alice, data, extra = {}) => {
    const response = await fetch(origin + path, { method: data === undefined ? "GET" : "POST", headers: {
      cookie: `account_session=${who.token}`, origin, "content-type": "application/json", "x-csrf-token": who.session.csrf,
      "x-session-binding": who.session.sessionBinding, ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  };
  const input = { roomId: "commons", displayName: "Alice Applicant", requestedPermissions: [], requestId: "account-join" };
  return { store, access, owner, alice, bob, call, input };
}

test("account admission binds the actual human account only after reviewed approval", async t => {
  const f = await fixture(t);
  const initial = await f.call("/api/account/access-requests", f.alice, f.input);
  assert.equal(initial.status, 201, JSON.stringify(initial.body));
  assert.equal(initial.body.request.principalKind, "account"); assert.equal(initial.body.request.identityId, null);
  assert.equal(f.store.db.prepare("SELECT status FROM access_requests WHERE request_id=?").get(f.input.requestId).status, "pending_account");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id='alice-account'").get().n, 0);
  const event = JSON.parse(f.store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence DESC LIMIT 1").get().body);
  assert.equal(event.data.identityId, `request:${f.input.requestId}`);
  assert.ok(!JSON.stringify(event).includes("alice-account"));
  const sessionBefore = f.store.authenticateAccountSession(f.alice.token);
  const before = f.store.room("commons").sequence;
  assert.deepEqual((await f.call("/api/account/access-requests", f.alice, f.input)).body, initial.body);
  assert.equal(f.store.room("commons").sequence, before);
  assert.equal(f.access.list(f.owner, "commons").filter(r => r.requestId === f.input.requestId).length, 1);
  const approved = f.access.decide(f.owner, "commons", f.input.requestId, { decision: "approve" });
  assert.equal(f.store.room("commons").state.members[approved.memberId].kind, "human");
  assert.equal(f.store.accountForMember("commons", approved.memberId).id, "alice-account");
  assert.equal(f.store.authenticateAccountSession(f.alice.token, "commons").member.id, approved.memberId);
  assert.deepEqual(f.store.authenticateAccountSession(f.alice.token), sessionBefore);
  assert.throws(() => f.store.authenticateAccountSession(f.bob.token, "commons"), e => e.status === 403);
  assert.equal((await f.call(`/api/account/access-requests/${f.input.requestId}`)).body.request.memberId, approved.memberId);
  assert.throws(() => f.access.decide(f.owner, "commons", f.input.requestId, { decision: "approve" }), e => e.code === "already_decided");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id='alice-account'").get().n, 1);
  assert.ok(!JSON.stringify(f.access.list(f.owner, "commons", { status: "approved" })).includes("alice-account"));
});

test("account request auth, CSRF, principal and status boundaries cannot be bypassed", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/account/access-requests", f.alice, { ...f.input, accountId: "bob-account" })).status, 422);
  assert.equal((await f.call("/api/account/access-requests", f.alice, { ...f.input, identityId: "forged" })).status, 422);
  assert.equal((await f.call("/api/account/access-requests", f.alice, f.input, { "x-csrf-token": "0".repeat(64) })).status, 403);
  assert.equal((await f.call("/api/account/access-requests", f.alice, f.input, { "x-session-binding": f.bob.session.sessionBinding })).status, 409);
  assert.equal((await f.call("/api/account/access-requests", f.alice, f.input)).status, 201);
  assert.equal((await f.call(`/api/account/access-requests/${f.input.requestId}`, f.bob)).status, 404);
  assert.equal((await f.call(`/api/account/access-requests/${f.input.requestId}`, f.bob, {})).status, 404);
  const row = f.store.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(f.input.requestId);
  assert.throws(() => f.access.status(f.input.requestId, row.identity_id), e => e.status === 404);
  assert.equal(f.access.tryAutoApprove("commons", f.input.requestId).approved, false);
  assert.equal((await f.call("/api/account/access-requests", f.alice, { ...f.input, displayName: "Changed" })).status, 409);
  f.store.db.prepare("UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id='alice-account'").run();
  assert.equal((await f.call(`/api/account/access-requests/${f.input.requestId}`)).status, 401);
  assert.throws(() => f.access.decide(f.owner, "commons", f.input.requestId, { decision: "approve" }), e => e.code === "account_access_changed");
});

test("failed account binding rolls back membership event and approval, while denial/cancel never admit", async t => {
  const f = await fixture(t);
  await f.call("/api/account/access-requests", f.alice, f.input);
  const before = f.store.room("commons");
  const original = f.store.ensureHumanAccountBinding;
  f.store.ensureHumanAccountBinding = () => { throw new Error("simulated binding failure"); };
  assert.throws(() => f.access.decide(f.owner, "commons", f.input.requestId, { decision: "approve" }), /binding failure/);
  f.store.ensureHumanAccountBinding = original;
  assert.deepEqual(f.store.room("commons"), before);
  assert.equal(f.access.statusAccount(f.alice.token, f.input.requestId, f.alice.session.sessionBinding).status, "pending");
  f.access.decide(f.owner, "commons", f.input.requestId, { decision: "deny" });
  assert.equal((await f.call(`/api/account/access-requests/${f.input.requestId}`)).body.request.status, "denied");
  await f.call("/api/account/access-requests", f.alice, { ...f.input, requestId: "cancel-join" });
  assert.equal((await f.call("/api/account/access-requests/cancel-join", f.alice, {})).body.request.status, "cancelled");
  assert.equal((await f.call("/api/account/access-requests/cancel-join", f.alice, {})).body.request.status, "cancelled");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id='alice-account'").get().n, 0);
});

test("approval rechecks account existence, room state, membership and capacity", async t => {
  for (const scenario of ["deleted", "disabled", "archived", "capacity", "name-taken", "removed"]) await t.test(scenario, async t => {
    const f = await fixture(t);
    await f.call("/api/account/access-requests", f.alice, f.input);
    if (scenario === "deleted") {
      f.store.db.prepare("DELETE FROM account_session_slots WHERE account_id='alice-account'").run();
      f.store.db.prepare("DELETE FROM account_credentials WHERE account_id='alice-account'").run();
      f.store.db.prepare("DELETE FROM accounts WHERE id='alice-account'").run();
    }
    if (scenario === "disabled") f.store.db.prepare("UPDATE accounts SET active=0 WHERE id='alice-account'").run();
    const command = data => f.store.command(f.owner, "commons", { id: crypto.randomUUID(), type: "member.added", data });
    if (scenario === "archived") f.store.command(f.owner, "commons", { id: crypto.randomUUID(), type: "room.archived", data: {} });
    if (scenario === "capacity") for (let i = 1; i < 100; i++) command({ memberId: `member${i}`, displayName: `Member ${i}`, kind: "human", permissions: [] });
    if (scenario === "name-taken") command({ memberId: "name-taken", displayName: f.input.displayName, kind: "human", permissions: [] });
    if (scenario === "removed") {
      command({ memberId: "former", displayName: "Former Member", kind: "human", permissions: [] });
      f.store.bindHumanAccount("commons", "former", "alice-account");
      f.store.command(f.owner, "commons", { id: crypto.randomUUID(), type: "member.access_changed", data: { memberId: "former", expectedMemberRevision: 0, permissions: [], active: false } });
    }
    const before = f.store.room("commons");
    assert.throws(() => f.access.decide(f.owner, "commons", f.input.requestId, { decision: "approve" }), e => ["account_access_changed", "room_archived", "pilot_limit", "display_name_unavailable", "membership_conflict"].includes(e.code));
    assert.deepEqual(f.store.room("commons"), before);
    assert.equal(f.store.db.prepare("SELECT status FROM access_requests WHERE request_id=?").get(f.input.requestId).status, "pending_account");
    if (scenario === "deleted") assert.equal(f.store.db.prepare("SELECT id FROM accounts WHERE id='alice-account'").get(), undefined);
  });
});

test("another reviewed request cannot change an existing account membership grant", async t => {
  const f = await fixture(t);
  await f.call("/api/account/access-requests", f.alice, f.input);
  await f.call("/api/account/access-requests", f.alice, { ...f.input, requestId: "second-request", requestedPermissions: ["accept_work"] });
  const first = f.access.decide(f.owner, "commons", f.input.requestId, { decision: "approve" });
  const second = f.access.decide(f.owner, "commons", "second-request", { decision: "approve" });
  assert.equal(second.memberId, first.memberId); assert.equal(second.alreadyMember, true);
  assert.deepEqual(second.grantedPermissions, []);
  assert.deepEqual(f.store.accountRooms(f.alice.token, f.alice.session.sessionBinding).rooms.map(room => room.id), ["commons"]);
  assert.deepEqual(f.store.accountRooms(f.bob.token, f.bob.session.sessionBinding).rooms, []);
});
