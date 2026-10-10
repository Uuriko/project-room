// A since_join reader who is removed and reactivated must not see a mention
// recorded during the gap. listRoomUpdates reads projectRoom(), which also
// feeds the owed-replies list.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { listRoomUpdates } from "../server/updates.mjs";

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "updates-history-floor-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  let now = Date.parse("2026-10-08T00:00:00.000Z");
  store.now = () => (now += 1000);
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a since_join reactivation hides the earlier mention from the updates feed", () => {
  const { store, close } = openStore();
  try {
    const owner = store.issueAccessKey("commons", "owner");
    const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
    cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
    cmd(T.MEMBER_ADDED, { memberId: "late", displayName: "Late", kind: "human", permissions: [] });
    cmd(T.MESSAGE_POSTED, { messageId: "gap-msg", body: "gap secret for @Late" });
    cmd(T.MESSAGE_POSTED, { messageId: "gap-dm", body: "dm secret before gap", toMemberId: "late" });
    const gapRevision = store.snapshot(owner, "commons").state.members.late.revision;
    cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: gapRevision, permissions: [], active: false });
    const removedRevision = store.snapshot(owner, "commons").state.members.late.revision;
    cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: removedRevision, permissions: [], active: true });
    const late = store.issueAccessKey("commons", "late");
    cmd(T.MESSAGE_POSTED, { messageId: "after-msg", body: "welcome back @Late" });

    const feed = listRoomUpdates(store, late, "commons");
    assert.deepEqual(feed.items.filter(item => item.kind === "mention").map(item => item.sourceRef.messageId), ["after-msg"]);
    assert.equal(feed.items.some(item => item.kind === "dm" && item.sourceRef.messageId === "gap-dm"), false);
    assert.equal(JSON.stringify(feed).includes("gap secret"), false);
    assert.equal(JSON.stringify(feed).includes("gap-msg"), false);
    assert.equal(JSON.stringify(feed).includes("dm secret"), false);
  } finally {
    close();
  }
});

test("a room that does not use since_join still lists the mention", () => {
  const { store, close } = openStore();
  try {
    const owner = store.issueAccessKey("commons", "owner");
    const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
    cmd(T.MEMBER_ADDED, { memberId: "late", displayName: "Late", kind: "human", permissions: [] });
    cmd(T.MESSAGE_POSTED, { messageId: "gap-msg", body: "gap secret for @Late" });
    const late = store.issueAccessKey("commons", "late");
    const feed = listRoomUpdates(store, late, "commons");
    assert.deepEqual(feed.items.filter(item => item.kind === "mention").map(item => item.sourceRef.messageId), ["gap-msg"]);
  } finally {
    close();
  }
});
