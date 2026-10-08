// PRIV-2 #1523 follow-up: a since_join member removed (member.access_changed
// active:false) and later reactivated (member.access_changed active:true) must
// not read messages posted during the removal gap. The live reactivation path
// (server/guest-invites.mjs reactivateGuestSeat) emits member.access_changed,
// NOT a fresh member.added -- so a floor built only from join events never
// moves and the gap stays readable on every surface (conversation, search,
// events, saved messages, pins).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { listSaved, setSaved } from "../server/activity.mjs";
import { readConversation } from "../server/conversation-sync.mjs";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "floor-reactivation-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  let now = Date.parse("2026-10-08T00:00:00.000Z");
  store.now = () => (now += 1000);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (type, data, token = owner) =>
    store.command(token, "commons", { id: randomUUID(), type, data });
  return { store, directory, owner, cmd, now: () => now };
}

test("reactivation moves the history floor past the removal gap", t => {
  const { store, directory, cmd } = setup();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  cmd(T.MESSAGE_POSTED, { messageId: "before", body: "pre-join note" });
  cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  cmd(T.MEMBER_ADDED, { memberId: "bob", displayName: "Bob", kind: "human", permissions: [] });
  const joinAt = store.room("commons").state.members["bob"];
  assert.ok(joinAt);
  cmd(T.MESSAGE_POSTED, { messageId: "gap-1", body: "removal gap secret one" });
  let rev = store.room("commons").state.members["bob"].revision;
  cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "bob", expectedMemberRevision: rev, permissions: [], active: false });
  cmd(T.MESSAGE_POSTED, { messageId: "gap-2", body: "removal gap secret two" });
  rev = store.room("commons").state.members["bob"].revision;
  cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "bob", expectedMemberRevision: rev, permissions: [], active: true });
  const reactivate = store.db.prepare(
    `SELECT sequence, json_extract(body,'$.at') AS at FROM events WHERE room_id='commons'
     AND json_extract(body,'$.type')='member.access_changed'
     AND json_extract(body,'$.data.memberId')='bob' AND json_extract(body,'$.data.active')=1
     ORDER BY sequence DESC LIMIT 1`).get();
  cmd(T.MESSAGE_POSTED, { messageId: "after", body: "post-reactivation note" });
  const bob = store.issueAccessKey("commons", "bob");

  const floor = store.historyFloor("commons", "bob");
  assert.ok(floor, "since_join member gets a floor");
  assert.equal(floor.sequence, reactivate.sequence,
    "floor is the reactivation event, not the original join");
  assert.equal(floor.at, reactivate.at);

  // Gap messages are unreadable on every surface...
  assert.throws(() => setSaved(store, bob, "commons", { messageId: "gap-2", saved: true }),
    error => error.status === 404, "cannot save a removal-gap message");
  const conv = readConversation(store, bob, "commons", { limit: 50 });
  const ids = (conv.messages ?? []).map(m => m.id);
  assert.ok(!ids.includes("gap-1") && !ids.includes("gap-2"), "conversation hides the gap");
  const found = store.search(bob, "commons", "removal gap", "messages", null, { limit: 50 });
  assert.equal((found.messages ?? []).length, 0, "search hides the gap");

  // ...while post-reactivation messages stay readable (no over-hiding).
  setSaved(store, bob, "commons", { messageId: "after", saved: true });
  assert.deepEqual(listSaved(store, bob, "commons").items.map(i => i.messageId), ["after"]);
  assert.ok(ids.includes("after"), "post-reactivation message visible");
});

test("an access_changed that only touches permissions does not move the floor", t => {
  const { store, directory, cmd } = setup();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  cmd(T.MEMBER_ADDED, { memberId: "carol", displayName: "Carol", kind: "human", permissions: [] });
  cmd(T.MESSAGE_POSTED, { messageId: "c1", body: "carol-era note" });
  // Owner affirms Carol's active membership without any deactivation.
  const rev = store.room("commons").state.members["carol"].revision;
  cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "carol", expectedMemberRevision: rev, permissions: [], active: true });
  cmd(T.MESSAGE_POSTED, { messageId: "c2", body: "later note" });
  const carol = store.issueAccessKey("commons", "carol");

  // c1 predates the affirmation but postdates Carol's join: still readable.
  setSaved(store, carol, "commons", { messageId: "c1", saved: true });
  setSaved(store, carol, "commons", { messageId: "c2", saved: true });
  assert.deepEqual(
    listSaved(store, carol, "commons").items.map(i => i.messageId).sort(), ["c1", "c2"]);
});
