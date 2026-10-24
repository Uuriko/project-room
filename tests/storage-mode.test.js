// A room stays on the full projection until its messages table matches.
// After the flip, the stored row keeps a hot window and the counters, and
// rehydrate writes the full projection back.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { SLIM_MESSAGE_WINDOW } from "../server/storage-mode.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-storage-mode-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.roomFlood = { consume() {}, refund() {} };
  const owner = store.issueAccessKey("commons", "owner");
  const post = (messageId, body) => store.command(owner, "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body }
  });
  const mode = () => store.db.prepare("SELECT storage_mode FROM rooms WHERE id='commons'").get().storage_mode;
  const bytes = () => Buffer.byteLength(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  const catchUp = () => {
    for (let i = 0; i < 40; i += 1) if (store.backfillMessages({ limit: 2000 }).done) break;
    assert.equal(store.checkMessagesParity({ roomId: "commons" }).ok, true);
  };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, post, mode, bytes, catchUp };
}

test("a room stays blob, and a mismatched message blocks the flip", t => {
  const room = open(t);
  assert.equal(room.mode(), "blob");
  for (let i = 0; i < 60; i += 1) room.post(`m${i}`, `line ${i} ` + "x".repeat(80));
  const refused = room.store.flipRoomToSlim("commons");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "messages_backfill");
  assert.equal(room.mode(), "blob");
  assert.equal(room.store.room("commons").state.messages.length, 60);

  room.catchUp();
  const body = room.store.db.prepare("SELECT body FROM messages WHERE room_id='commons' AND message_id='m3'").get().body;
  room.store.db.prepare("UPDATE messages SET body=? WHERE room_id='commons' AND message_id='m3'").run("tampered");
  const mismatch = room.store.flipRoomToSlim("commons");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "dual_read");
  assert.equal(mismatch.messageId, "m3");
  assert.equal(room.mode(), "blob");
  assert.equal(room.store.room("commons").state.messages.length, 60);
  room.store.db.prepare("UPDATE messages SET body=? WHERE room_id='commons' AND message_id='m3'").run(body);
});

test("after verification the hot projection stays bounded, and rehydrate restores blob mode", t => {
  const room = open(t);
  room.store.command(room.owner, "commons", {
    id: randomUUID(), type: T.WORK_PROPOSED, data: {
      workItemId: "w1", title: "Hold", definitionOfDone: "Still listed", accountableMemberId: "owner", mode: "read"
    }
  });
  for (let i = 0; i < 60; i += 1) room.post(`m${i}`, `line ${i} ` + "x".repeat(400));
  room.catchUp();
  const before = room.bytes();
  const flipped = room.store.flipRoomToSlim("commons");
  assert.equal(flipped.ok, true, JSON.stringify(flipped));
  assert.equal(room.mode(), "slim");
  const slim = room.store.room("commons").state;
  assert.equal(slim.messages.length, SLIM_MESSAGE_WINDOW);
  assert.equal(slim.messageCount, 60);
  assert.equal(slim.openWorkCount, 1);
  assert.ok(slim.lastSeq > 0);
  assert.equal(slim.messages.at(-1).body, "line 59 " + "x".repeat(400));
  assert.ok(room.bytes() < before / 2, `before ${before}, after ${room.bytes()}`);
  assert.ok(room.bytes() <= 100 * 1024, `hot projection ${room.bytes()}`);
  assert.equal(slim.workItems.w1.title, "Hold");

  for (let i = 0; i < 10; i += 1) room.post(`n${i}`, `follow ${i}`);
  const after = room.store.room("commons").state;
  assert.equal(after.messages.length, SLIM_MESSAGE_WINDOW);
  assert.equal(after.messageCount, 70);
  assert.equal(after.messages.some(message => message.id === "m0"), false);
  assert.equal(after.messages.find(message => message.id === "n9").body, "follow 9");

  assert.equal(room.store.rehydrateAllProjections() >= 1, true);
  assert.equal(room.mode(), "blob");
  const restored = room.store.room("commons").state;
  assert.equal(restored.messages.length, 70);
  assert.equal(restored.messages.find(message => message.id === "m0").body, "line 0 " + "x".repeat(400));
});
