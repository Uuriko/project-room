// #1523: since_join floor must use the LATEST join event for the member,
// not the first-ever one. A guest removed and later re-added (reactivated)
// must not read messages posted during their removal gap.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { historyFloor, messageInHistory } from "../server/history-visibility.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function setup() {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  return { store, cmd };
}

test("#1523: reactivated member's floor is the latest join, hiding the removal gap", t => {
  const { store, cmd } = setup(t);
  t.after(() => store.close());
  cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  // First join.
  cmd(T.MEMBER_ADDED, { memberId: "guest-1", displayName: "Guest", kind: "agent", permissions: [], accountableHumanId: "owner" });
  cmd(T.MESSAGE_POSTED, { messageId: "msg-during-first-stay", body: "hello from the first stay" });
  // Removal: access ended.
  const rev1 = store.room("commons").state.members["guest-1"].revision;
  cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "guest-1", expectedMemberRevision: rev1, permissions: [], active: false });
  cmd(T.MESSAGE_POSTED, { messageId: "msg-in-removal-gap", body: "secret plans while the guest is gone" });
  // Reactivation: a second member.added for the same member id (the join
  // the floor query must now honor).
  const rev2 = store.room("commons").state.members["guest-1"].revision;
  cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "guest-1", expectedMemberRevision: rev2, permissions: [], active: true });
  // NOTE: addMember refuses a duplicate memberId, so the reactivation join
  // is recorded directly the way a re-admission writes it.
  const roomId = "commons";
  const joinAt = new Date(store.now()).toISOString();
  const seq = store.room(roomId).sequence + 1;
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, seq,
    randomUUID(), JSON.stringify({
      id: randomUUID(), type: T.MEMBER_ADDED, roomId, actorId: "owner", at: joinAt,
      data: { memberId: "guest-1", displayName: "Guest", kind: "agent", permissions: [] }
    }));
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(seq, roomId);
  cmd(T.MESSAGE_POSTED, { messageId: "msg-after-rejoin", body: "welcome back" });

  const state = store.room(roomId).state;
  const floor = historyFloor(store.db, state, roomId, "guest-1");
  assert.ok(floor, "a floor must exist");
  assert.equal(floor.sequence, seq, "the floor is the LATEST join event, not the first");

  const messages = Object.fromEntries(state.messages.map(m => [m.id, m]));
  assert.equal(messageInHistory(messages["msg-during-first-stay"], floor), false,
    "messages from the first stay are hidden after reactivation");
  assert.equal(messageInHistory(messages["msg-in-removal-gap"], floor), false,
    "messages posted during the removal gap stay hidden");
  assert.equal(messageInHistory(messages["msg-after-rejoin"], floor), true,
    "messages after the rejoin stay visible");
});

test("#1523: a single join is unaffected (floor is that join)", t => {
  const { store, cmd } = setup(t);
  t.after(() => store.close());
  cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  cmd(T.MEMBER_ADDED, { memberId: "guest-2", displayName: "Guest 2", kind: "agent", permissions: [], accountableHumanId: "owner" });
  cmd(T.MESSAGE_POSTED, { messageId: "msg-1", body: "hi" });
  const state = store.room("commons").state;
  const floor = historyFloor(store.db, state, "commons", "guest-2");
  assert.ok(floor);
  const messages = Object.fromEntries(state.messages.map(m => [m.id, m]));
  assert.equal(messageInHistory(messages["msg-1"], floor), true);
});
