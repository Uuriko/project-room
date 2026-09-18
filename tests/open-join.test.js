// Open rooms: join by shareable link alone (Uuriko/project-room#612,
// RC-2026-09-18-017). An owner flips the openJoin policy; after that, an
// agent (pri_ identity secret) or a human (account session token) joins with
// one call. Missing rooms, malformed ids and closed rooms answer the same
// 404; joins land with the fixed chat profile and are audited as
// member.added with basis:"open_join".
//
// NOTE: these tests exercise the OpenJoin class directly. The HTTP route
// (POST /api/rooms/{roomId}/join) is parked in
// ~/workspace/pr-open-join-hold/route-surface.patch until PR #584 (Telegram
// webhook rotation, which owns server/http.mjs) merges; the HTTP-specific
// assertions (bearer extraction, body field allowlist, per-address rate
// limit, 201/200 mapping) are re-enabled with it.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { OpenJoin } from "../server/open-join.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-open-join-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("open-room"));
  store.initialize(initialRoom("closed-room"));
  const open = room => store.command(store.issueAccessKey(room, "owner"), room,
    { id: randomUUID(), type: "room.policy_set", data: { requireIndependentReview: false, requireOwnerDecision: false, openJoin: true } });
  open("open-room");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, openJoin: new OpenJoin(store), open };
}

test("agent joins an open room with the chat profile and basis open_join", t => {
  const { store, openJoin } = fixture(t);
  const identity = store.identities.create("Joiner Bot");
  const before = store.room("open-room").sequence;
  const result = openJoin.join("open-room", identity.secret, {});
  assert.equal(result.roomId, "open-room");
  assert.equal(result.memberId, identity.identityId);
  assert.equal(result.kind, "agent");
  assert.deepEqual(result.permissions, []);
  assert.equal(result.alreadyMember, false);
  assert.equal(result.displayName, "Joiner Bot");
  // Projection carries the member with chat permissions.
  const room = store.room("open-room");
  assert.equal(room.sequence, before + 1);
  const member = room.state.members[identity.identityId];
  assert.equal(member.kind, "agent");
  assert.deepEqual(member.permissions, []);
  assert.equal(member.identityId, identity.identityId);
  // The audit event names the joiner, the time and the open-join basis.
  const eventRow = store.db.prepare("SELECT body FROM events WHERE room_id=? AND sequence=?").get("open-room", before + 1);
  const incoming = JSON.parse(eventRow.body);
  assert.equal(incoming.type, "member.added");
  assert.equal(incoming.data.memberId, identity.identityId);
  assert.equal(incoming.data.basis, "open_join");
  assert.equal(typeof incoming.at, "string");
  // The identity link lets the agent authenticate as the new member.
  const link = store.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?").get("open-room", identity.identityId);
  assert.equal(link.member_id, identity.identityId);
  // ...and the chat profile actually works: the joined agent can post.
  const memberKey = store.issueAccessKey("open-room", identity.identityId);
  const posted = store.command(memberKey, "open-room",
    { id: randomUUID(), type: "message.posted", data: { body: "hello from the open room" } });
  assert.equal(posted.event.type, "message.posted");
});

test("rejoin is idempotent and returns already_member without writing", t => {
  const { store, openJoin } = fixture(t);
  const identity = store.identities.create("Repeat Bot");
  const first = openJoin.join("open-room", identity.secret, {});
  assert.equal(first.alreadyMember, false);
  const sequence = store.room("open-room").sequence;
  const second = openJoin.join("open-room", identity.secret, {});
  assert.equal(second.alreadyMember, true);
  assert.equal(second.memberId, identity.identityId);
  assert.equal(store.room("open-room").sequence, sequence);
});

test("closed rooms, missing rooms and malformed ids answer the same 404", t => {
  const { store, openJoin, open } = fixture(t);
  const identity = store.identities.create("Snooper Bot");
  for (const roomId of ["closed-room", "no-such-room", "bad id"]) {
    assert.throws(() => openJoin.join(roomId, identity.secret, {}),
      { status: 404, code: "join_unavailable" }, `roomId ${roomId}`);
  }
  // A closed room can be opened later and then joins work.
  open("closed-room");
  const after = openJoin.join("closed-room", identity.secret, {});
  assert.equal(after.alreadyMember, false);
  assert.equal(after.roomId, "closed-room");
});

test("join requires a credential: none, garbage and wrong-shape all fail", t => {
  const { openJoin, store } = fixture(t);
  const identity = store.identities.create("Cred Bot");
  assert.throws(() => openJoin.join("open-room", undefined, {}), { status: 401 });
  assert.throws(() => openJoin.join("open-room", "not-a-real-credential", {}), { status: 401 });
  // A well-formed but unknown pri_ secret is still unauthenticated.
  const other = store.identities.create("Other Bot");
  const fakeSecret = other.secret.slice(0, -4) + "AAAA";
  assert.throws(() => openJoin.join("open-room", fakeSecret, {}), { status: 401, code: "unauthenticated" });
  assert.equal(identity.secret.length > 0, true);
});

test("displayName is optional and bounded", t => {
  const { openJoin, store } = fixture(t);
  const named = store.identities.create("Named Bot");
  const withName = openJoin.join("open-room", named.secret, { displayName: "Link Visitor" });
  assert.equal(withName.displayName, "Link Visitor");
  const tooLong = store.identities.create("Long Bot");
  assert.throws(() => openJoin.join("open-room", tooLong.secret, { displayName: "x".repeat(81) }),
    { status: 422, code: "invalid_join" });
});

test("human joins with an account session token and binds the account", t => {
  const { store, openJoin } = fixture(t);
  store.createAccount("human-joiner");
  const slot = store.createAccountSessionSlot();
  const key = store.issueAccountAccessKey("human-joiner");
  store.loginAccountSession(slot.token, key, 0);
  const result = openJoin.join("open-room", slot.token, { displayName: "Human Visitor" });
  assert.equal(result.kind, "human");
  assert.match(result.memberId, /^human-[0-9a-f]{12}$/);
  assert.equal(result.displayName, "Human Visitor");
  assert.deepEqual(result.permissions, []);
  const binding = store.db.prepare("SELECT member_id FROM member_accounts WHERE room_id=? AND account_id=?").get("open-room", "human-joiner");
  assert.equal(binding.member_id, result.memberId);
  // The human member is fully functional: a room credential issued for the
  // joined member can post with the chat profile.
  const memberKey = store.issueAccessKey("open-room", result.memberId);
  const posted = store.command(memberKey, "open-room",
    { id: randomUUID(), type: "message.posted", data: { body: "human hello" } });
  assert.equal(posted.event.type, "message.posted");
  // Human rejoin is idempotent too.
  const again = openJoin.join("open-room", slot.token, {});
  assert.equal(again.alreadyMember, true);
});

test("per-joiner rate limit blunts join guessing across rooms", t => {
  const { store, open } = fixture(t);
  const openJoin = new OpenJoin(store, { rateLimiter: createRateLimiter({ capacity: 1, refillPerSecond: 1 / 3600 }) });
  const first = store.identities.create("Rate Bot One");
  const second = store.identities.create("Rate Bot Two");
  store.initialize(initialRoom("open-room-2"));
  open("open-room-2");
  const ok = openJoin.join("open-room", first.secret, {});
  assert.equal(ok.alreadyMember, false);
  // Same joiner, second open room: budget exhausted.
  assert.throws(() => openJoin.join("open-room-2", first.secret, {}), { status: 429, code: "rate_limited" });
  // A different joiner still has budget.
  const other = openJoin.join("open-room-2", second.secret, {});
  assert.equal(other.alreadyMember, false);
  // Rejoin short-circuits before the limiter: the exhausted joiner can
  // still rejoin rooms it already belongs to.
  const rejoin = openJoin.join("open-room", first.secret, {});
  assert.equal(rejoin.alreadyMember, true);
});
