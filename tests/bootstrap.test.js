
// QA200-REG-14 regression sweep (2026-10-08): fail-first coverage for
// server/bootstrap.mjs — the genesis events every test fixture and the
// server boot path depend on. Any change to the event sequence, the owner
// member record, or the permission grant must be deliberate.
import test from "node:test";
import assert from "node:assert/strict";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";

test("initialRoom emits room.created then member.added for the owner", () => {
  const events = initialRoom();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, T.ROOM_CREATED);
  assert.equal(events[1].type, T.MEMBER_ADDED);
  assert.equal(events[0].roomId, "commons");
  assert.equal(events[0].data.roomId, "commons");
  assert.equal(events[0].data.ownerId, "owner");
});

test("initialRoom honours custom roomId and ownerId wiring", () => {
  const [created, added] = initialRoom("lobby", "alice");
  assert.equal(created.roomId, "lobby");
  assert.equal(created.actorId, "alice");
  assert.equal(added.data.memberId, "alice");
  assert.equal(added.data.displayName, "Room owner");
  assert.equal(added.data.kind, "human");
});

test("initialRoom grants the owner the full permission set", () => {
  const [, added] = initialRoom();
  assert.deepEqual([...added.data.permissions].sort(), [...PERMISSIONS].sort());
  for (const gated of ["decide", "manage_members", "write_external", "invite_member"]) {
    assert.ok(added.data.permissions.includes(gated), `owner must hold ${gated}`);
  }
});
