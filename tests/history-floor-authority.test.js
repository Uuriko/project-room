// Read-path: every eventsAfter page ran historyFloor, which re-fetched the
// room authority (a full-projection JSON parse, ~22-47ms on a 10k-message
// room) even though the caller already held it. historyFloor now accepts a
// pre-fetched authority; the re-fetch is the fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

function seeded(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Floor Owner");
  const reader = store.identities.create("Floor Reader");
  const roomId = "floor-auth";
  rooms.create(owner.secret, { roomId, title: roomId, purpose: "floor authority", kind: "personal" });
  store.identities.link(owner.secret, roomId, { identityId: reader.identityId, displayName: "Reader", permissions: [] });
  const readerMemberId = store.db.prepare("SELECT member_id FROM identity_links WHERE identity_id=?").get(reader.identityId).member_id;
  return { store, rooms, owner, roomId, readerMemberId, readerSecret: reader.secret };
}

test("historyFloor with a pre-fetched authority matches the re-fetching call", t => {
  const { store, roomId, readerMemberId } = seeded(t);
  const authority = store.roomAuthority(roomId);
  const sequence = authority.sequence;
  // Default visibility: no floor either way.
  assert.equal(store.historyFloor(roomId, readerMemberId, sequence), null);
  assert.equal(store.historyFloor(roomId, readerMemberId, sequence, authority), null);
});

test("historyFloor with a pre-fetched authority matches under since_join", t => {
  const { store, owner, roomId } = seeded(t);
  // A real join event so the floor has something to find.
  store.command(owner.secret, roomId, { id: randomUUID(), type: "member.added",
    data: { memberId: "late-joiner", displayName: "Late", kind: "agent", permissions: [] } });
  store.command(owner.secret, roomId, { id: randomUUID(), type: "room.history_visibility_set",
    data: { historyVisibility: "since_join" } });
  const authority = store.roomAuthority(roomId);
  const sequence = authority.sequence;
  const fresh = store.historyFloor(roomId, "late-joiner", sequence);
  const shared = store.historyFloor(roomId, "late-joiner", sequence, authority);
  assert.ok(fresh, "since_join member gets a floor");
  assert.deepEqual(shared, fresh, "pre-fetched authority must not change the floor");
  assert.equal(shared.sequence, fresh.sequence);
});

test("an eventsAfter page performs exactly two roomAuthority reads", t => {
  const { store, roomId, readerSecret } = seeded(t);
  const inner = store.roomAuthority.bind(store);
  let calls = 0;
  store.roomAuthority = (...args) => { calls++; return inner(...args); };
  try {
    store.eventsAfter(readerSecret, roomId, 0, 10);
  } finally {
    store.roomAuthority = inner;
  }
  // Two reads are legitimate: identity auth resolves the member, then the
  // page fetches sequence/ownerId/members. The third — historyFloor
  // re-fetching the same authority — is the waste this removes (was 3).
  assert.equal(calls, 2, `eventsAfter must not re-fetch the authority inside historyFloor (was 3, got ${calls})`);
});
