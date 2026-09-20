import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { auditCharters } from "../src/room-charter.js";
import { auditRecovery } from "../server/recovery.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// auditCharters modelled a room that never changes hands and is always owned by
// a human. The product does both: ownership.transferred is a shipped feature,
// and POST /api/agent-rooms creates rooms whose founding member is an agent.
//
// Either one made this audit fail permanently, and it runs inside auditRecovery,
// which gates backupRoom and loops every room - so one such room stopped the
// whole database being backed up, with nothing actually corrupt. Creating a
// self-serve agent room was a single API call that did it.

function room(t, roomId = "commons") {
  const directory = mkdtempSync(join(tmpdir(), "room-charter-audit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  store.initialize(initialRoom(roomId));
  store.db.exec(agentRoomSchema);
  const keys = { owner: store.issueAccessKey(roomId, "owner") };
  const send = (actor, type, data) => store.command(keys[actor], roomId, { id: randomUUID(), type, data });
  const state = () => store.room(roomId).state;
  send("owner", T.MEMBER_ADDED, { memberId: "alice", displayName: "Alice", kind: "human", permissions: ["steer", "decide", "accept_work", "complete_work", "verify"] });
  keys.alice = store.issueAccessKey(roomId, "alice");
  return { store, send, keys, state, roomId };
}

const charter = fixture => ({ expectedRevision: fixture.state().room.charter?.revision ?? 0, purpose: "Coordinate the pilot.", outputs: null, boundaries: null, escalation: null });

test("transferring the room does not break the audit or the backup", t => {
  const fixture = room(t);
  assert.doesNotThrow(() => auditRecovery(fixture.store), "clean before");
  fixture.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "alice", reason: "handing over" });
  assert.deepEqual(fixture.store.room("commons"), fixture.store.rebuildProjection("commons"), "the projection was never wrong");
  assert.doesNotThrow(() => auditRecovery(fixture.store), "and the audit must agree with it");
});

test("room instructions written before a transfer still audit after it", t => {
  const fixture = room(t);
  fixture.send("owner", T.ROOM_CHARTER_UPDATED, charter(fixture));
  fixture.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "alice", reason: "handing over" });
  assert.doesNotThrow(() => auditRecovery(fixture.store));
  assert.equal(fixture.state().room.charter.purpose, "Coordinate the pilot.");
});

test("the new owner can write room instructions, and that audits", t => {
  const fixture = room(t);
  fixture.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "alice", reason: "handing over" });
  fixture.send("alice", T.ROOM_CHARTER_UPDATED, charter(fixture));
  assert.equal(fixture.state().room.charter.updatedById, "alice");
  assert.doesNotThrow(() => auditRecovery(fixture.store), "the audit has to follow the owner");
});

test("a self-serve agent room audits clean", t => {
  const fixture = room(t);
  const identity = fixture.store.identities.create("Owning Agent");
  const created = new AgentRooms(fixture.store).create(identity.secret, {
    roomId: "agent-den", title: "Agent Den", purpose: "A room owned by an agent.", kind: "personal", displayName: "Den Keeper"
  });
  assert.equal(fixture.store.room("agent-den").state.members[created.ownerMemberId].kind, "agent");
  // One documented API call used to take the whole database's backup path down.
  assert.doesNotThrow(() => auditRecovery(fixture.store));
});

test("an agent owner still cannot write room instructions", t => {
  // The policy is unchanged; it just moved from the owner's membership, where
  // it condemned the whole room, to the charter event, where it refuses only
  // that write.
  const fixture = room(t);
  const identity = fixture.store.identities.create("Owning Agent");
  new AgentRooms(fixture.store).create(identity.secret, {
    roomId: "agent-den", title: "Agent Den", purpose: "A room owned by an agent.", kind: "personal", displayName: "Den Keeper"
  });
  const state = fixture.store.room("agent-den").state;
  const history = fixture.store.db.prepare("SELECT sequence,id,body FROM events WHERE room_id=? ORDER BY sequence").all("agent-den");
  history.push({ sequence: 99, id: randomUUID(), body: JSON.stringify({
    id: randomUUID(), type: T.ROOM_CHARTER_UPDATED, actorId: state.room.ownerId, roomId: "agent-den",
    at: new Date().toISOString(), data: { expectedRevision: 0, purpose: "agent-written", outputs: null, boundaries: null, escalation: null }
  }) });
  assert.throws(() => auditCharters(state, history), /Invalid room instructions author/);
});

test("a forged transfer is still caught", t => {
  const fixture = room(t);
  fixture.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "alice", reason: "handing over" });
  const state = fixture.store.room("commons").state;
  const history = () => fixture.store.db.prepare("SELECT sequence,id,body FROM events WHERE room_id=? ORDER BY sequence").all("commons");

  // Transferred to somebody who was never a member.
  const toStranger = history().map(row => {
    const event = JSON.parse(row.body);
    if (event.type !== T.OWNERSHIP_TRANSFERRED) return row;
    return { ...row, body: JSON.stringify({ ...event, data: { ...event.data, toMemberId: "never-a-member" } }) };
  });
  assert.throws(() => auditCharters(state, toStranger), /Invalid ownership transfer/);

  // Transferred by somebody who did not own the room.
  const byStranger = history().map(row => {
    const event = JSON.parse(row.body);
    if (event.type !== T.OWNERSHIP_TRANSFERRED) return row;
    return { ...row, body: JSON.stringify({ ...event, actorId: "alice" }) };
  });
  assert.throws(() => auditCharters(state, byStranger), /Invalid ownership transfer/);

  // And the transfer removed entirely, while the projection keeps the new owner.
  assert.throws(() => auditCharters(state, history().filter(row => !JSON.parse(row.body).type.startsWith("ownership."))),
    /Room instructions require reconciliation/);
});
