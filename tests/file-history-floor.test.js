// A since_join reader who is removed and reactivated must not list or
// download a room file committed to a message from the removal gap.
// RoomAttachments.list and RoomAttachments.get are the shared reads.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "file-history-floor-"));
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

function commitFile(store, token, id, messageId, text) {
  store.roomAttachments.stage(token, "commons", {
    id, filename: `${id}.txt`, mediaType: "text/plain", data: Buffer.from(text).toString("base64"),
  });
  store.roomAttachments.commit(token, "commons", { id, messageId });
}

test("a since_join reactivation hides a file committed during the gap", () => {
  const { store, close } = openStore();
  try {
    const owner = store.issueAccessKey("commons", "owner");
    const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
    cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
    cmd(T.MEMBER_ADDED, { memberId: "late", displayName: "Late", kind: "human", permissions: [] });
    const gapRevision = store.snapshot(owner, "commons").state.members.late.revision;
    cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: gapRevision, permissions: [], active: false });
    cmd(T.MESSAGE_POSTED, { messageId: "gap-msg", body: "gap secret file note" });
    commitFile(store, owner, "gap-file", "gap-msg", "gap-file-secret");
    const removedRevision = store.snapshot(owner, "commons").state.members.late.revision;
    cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: removedRevision, permissions: [], active: true });
    cmd(T.MESSAGE_POSTED, { messageId: "after-msg", body: "welcome back" });
    commitFile(store, owner, "after-file", "after-msg", "after-file");
    const late = store.issueAccessKey("commons", "late");

    const listed = store.roomAttachments.list(late, "commons");
    assert.deepEqual(listed.files.map(file => file.id), ["after-file"]);
    assert.equal(JSON.stringify(listed).includes("gap-file-secret"), false);
    assert.throws(
      () => store.roomAttachments.get(late, "commons", "gap-file"),
      error => error.status === 404 && error.code === "attachment_not_found",
    );
    const after = store.roomAttachments.get(late, "commons", "after-file");
    assert.equal(Buffer.from(after.attachment.data, "base64").toString(), "after-file");
    const ownerList = store.roomAttachments.list(owner, "commons");
    assert.deepEqual(ownerList.files.map(file => file.id).sort(), ["after-file", "gap-file"]);
  } finally {
    close();
  }
});

test("a room that does not use since_join still returns the earlier file", () => {
  const { store, close } = openStore();
  try {
    const owner = store.issueAccessKey("commons", "owner");
    const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
    cmd(T.MEMBER_ADDED, { memberId: "late", displayName: "Late", kind: "human", permissions: [] });
    cmd(T.MESSAGE_POSTED, { messageId: "gap-msg", body: "earlier note" });
    commitFile(store, owner, "gap-file", "gap-msg", "gap-file-secret");
    const late = store.issueAccessKey("commons", "late");
    const listed = store.roomAttachments.list(late, "commons");
    assert.deepEqual(listed.files.map(file => file.id), ["gap-file"]);
    const got = store.roomAttachments.get(late, "commons", "gap-file");
    assert.equal(Buffer.from(got.attachment.data, "base64").toString(), "gap-file-secret");
  } finally {
    close();
  }
});
