// Regression (PRIV-2): committed room files follow their message's history
// visibility. A since_join member must not list or download a file attached
// before they joined, and a file on a deleted message is not readable.
// Reported by John's Tab (dpaste GHZ2WPFRZ).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-files-history-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  let now = Date.parse("2026-10-03T12:00:00.000Z");
  store.now = () => (now += 1000);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  const attach = (id, messageId) => {
    const data = Buffer.from(`secret-${id}`).toString("base64");
    store.roomAttachments.stage(ownerKey, "commons", { id, filename: `${id}.txt`, mediaType: "text/plain", data });
    store.roomAttachments.commit(ownerKey, "commons", { id, messageId });
  };
  cmd(T.MESSAGE_POSTED, { messageId: "before", body: "before join" });
  attach("file-before", "before");
  cmd(T.MESSAGE_POSTED, { messageId: "doomed", body: "will be deleted" });
  attach("file-doomed", "doomed");
  cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  cmd(T.MEMBER_ADDED, { memberId: "late-agent", displayName: "Late agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  const lateKey = store.issueAccessKey("commons", "late-agent");
  cmd(T.MESSAGE_POSTED, { messageId: "after", body: "after join" });
  attach("file-after", "after");
  return { store, ownerKey, lateKey, cmd };
}

test("since_join member cannot list or read a file committed before their join", t => {
  const f = fixture(t);
  const ids = key => f.store.roomAttachments.list(key, "commons").files.map(file => file.id).sort();
  assert.deepEqual(ids(f.lateKey), ["file-after", "file-doomed"].filter(id => id !== "file-doomed"), "late member sees only the post-join file");
  assert.deepEqual(ids(f.ownerKey), ["file-after", "file-before", "file-doomed"], "owner reads everything");
  assert.throws(() => f.store.roomAttachments.get(f.lateKey, "commons", "file-before"), error => error.status === 404 && error.code === "attachment_not_found");
  assert.equal(f.store.roomAttachments.get(f.lateKey, "commons", "file-after").attachment.id, "file-after");
  assert.equal(f.store.roomAttachments.get(f.ownerKey, "commons", "file-before").attachment.id, "file-before");
});

test("a file on a deleted message is no longer listed or readable", t => {
  const f = fixture(t);
  f.cmd(T.MESSAGE_DELETED, { messageId: "doomed", expectedMessageRevision: 0 });
  assert.equal(f.store.roomAttachments.list(f.ownerKey, "commons").files.some(file => file.id === "file-doomed"), false);
  assert.throws(() => f.store.roomAttachments.get(f.ownerKey, "commons", "file-doomed"), error => [404, 410].includes(error.status));
});
