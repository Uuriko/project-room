// PRIV-2: listPins must not return a pinned message body from before a
// since_join reactivation. This read does not call listActivity, listRoomUpdates,
// Notifications.list, ReplyRequests, or RoomAttachments.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { listPins } from "../server/pins.mjs";

function room() {
  const directory = mkdtempSync(join(tmpdir(), "pins-history-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  let now = Date.parse("2026-10-08T00:00:00.000Z");
  store.now = () => (now += 1000);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
  cmd(T.MEMBER_ADDED, { memberId: "late", displayName: "Late", kind: "human", permissions: [] });
  return {
    store, owner, cmd, directory,
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

function pinGapThenReactivate(ctx) {
  const gapRevision = ctx.store.snapshot(ctx.owner, "commons").state.members.late.revision;
  ctx.cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: gapRevision, permissions: [], active: false });
  ctx.cmd(T.MESSAGE_POSTED, { messageId: "gap-msg", body: "gap pin secret" });
  ctx.cmd(T.MESSAGE_PINNED, { messageId: "gap-msg" });
  const removedRevision = ctx.store.snapshot(ctx.owner, "commons").state.members.late.revision;
  ctx.cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: removedRevision, permissions: [], active: true });
  ctx.cmd(T.MESSAGE_POSTED, { messageId: "after-msg", body: "welcome back pin" });
  ctx.cmd(T.MESSAGE_PINNED, { messageId: "after-msg" });
}

test("a since_join reactivation hides a pin from the removal gap", () => {
  const ctx = room();
  try {
    ctx.cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
    pinGapThenReactivate(ctx);
    const late = ctx.store.issueAccessKey("commons", "late");
    const listed = listPins(ctx.store, late, "commons");
    assert.equal(JSON.stringify(listed).includes("gap pin secret"), false);
    assert.deepEqual(listed.pins.map(pin => pin.messageId), ["after-msg"]);
    assert.equal(listed.pins[0].body, "welcome back pin");
    assert.equal(listed.count, 1);
    const ownerListed = listPins(ctx.store, ctx.owner, "commons");
    assert.deepEqual(ownerListed.pins.map(pin => pin.messageId), ["gap-msg", "after-msg"]);
  } finally {
    ctx.close();
  }
});

test("a room that does not use since_join still returns the gap pin body", () => {
  const ctx = room();
  try {
    pinGapThenReactivate(ctx);
    const late = ctx.store.issueAccessKey("commons", "late");
    const listed = listPins(ctx.store, late, "commons");
    assert.deepEqual(listed.pins.map(pin => pin.messageId), ["gap-msg", "after-msg"]);
    assert.equal(listed.pins[0].body, "gap pin secret");
  } finally {
    ctx.close();
  }
});
