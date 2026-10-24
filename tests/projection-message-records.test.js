// Message text and work-item text stay out of the room row. Readers still
// see both after a restart. An edit rewrites the one record that changed.
// A delete drops the text from the side table. The mode is opt-in.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { isSideMessageRef } from "../server/projection-message-records.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function open(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-side-msg-"));
  const file = join(directory, "room.sqlite");
  let store = new RoomStore(file, options);
  store.initialize(initialRoom());
  const owner = () => store.issueAccessKey("commons", "owner");
  const post = (messageId, body) => store.command(owner(), "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body }
  });
  const raw = () => store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  const records = () => store.db.prepare(
    "SELECT message_id, record FROM projection_message_records WHERE room_id='commons' ORDER BY message_id"
  ).all();
  const reopen = (next = options) => { store.close(); store = new RoomStore(file, next); return store; };
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, owner, post, raw, records, reopen };
}

const text = tag => `${tag}-` + "x".repeat(800);

test("off by default, message text stays in the room row and no side records exist", t => {
  const room = open(t);
  const body = text("plain");
  room.post("m0", body);
  assert.match(room.raw(), /plain-xxxx/);
  assert.equal(room.records().length, 0);
});

test("side-table projection keeps message and work text out of the room row", t => {
  const room = open(t, { sideTableMessages: true });
  const title = "Ship the side table";
  room.store.command(room.owner(), "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "w1", title, definitionOfDone: "Readers still see the work", accountableMemberId: "owner", mode: "read"
  } });
  const bodies = [];
  for (let i = 0; i < 20; i += 1) {
    bodies.push(text(`m${i}`));
    room.post(`m${i}`, bodies[i]);
  }
  const stored = room.raw();
  assert.equal(JSON.parse(stored).messages.every(isSideMessageRef), true);
  assert.equal(stored.includes(bodies[0]), false);
  assert.equal(stored.includes(title), false);
  assert.match(stored, /"_m":1/);
  assert.match(stored, /"_workEntity":1/);
  const recordBytes = room.records().reduce((sum, row) => sum + Buffer.byteLength(row.record), 0);
  assert.ok(recordBytes > 15_000, `side records hold the text (${recordBytes} bytes)`);
  assert.ok(Buffer.byteLength(stored) * 4 < recordBytes, `room row ${Buffer.byteLength(stored)} bytes, records ${recordBytes}`);
  assert.equal(room.store.room("commons").state.messages.find(message => message.id === "m19").body, bodies[19]);
  assert.equal(room.store.room("commons").state.workItems.w1.title, title);

  room.reopen({ sideTableMessages: true });
  assert.equal(room.store.room("commons").state.messages.find(message => message.id === "m0").body, bodies[0]);
  assert.equal(room.store.room("commons").state.workItems.w1.title, title);

  const before = new Map(room.records().map(row => [row.message_id, row.record]));
  room.store.command(room.owner(), "commons", { id: randomUUID(), type: T.MESSAGE_EDITED, data: {
    messageId: "m5", body: "edited line", expectedMessageRevision: 0
  } });
  const edited = new Map(room.records().map(row => [row.message_id, row.record]));
  assert.notEqual(edited.get("m5"), before.get("m5"));
  assert.match(edited.get("m5"), /edited line/);
  for (const [id, record] of before) {
    if (id === "m5") continue;
    assert.equal(edited.get(id), record, id);
  }

  room.store.command(room.owner(), "commons", { id: randomUUID(), type: T.MESSAGE_DELETED, data: {
    messageId: "m7", expectedMessageRevision: 0
  } });
  const deleted = room.records().find(row => row.message_id === "m7");
  assert.ok(deleted, "the tombstone stays addressable");
  assert.equal(deleted.record.includes(bodies[7]), false);
  assert.equal(room.store.room("commons").state.messages.find(message => message.id === "m7").body, null);
  const kept = room.records().find(row => row.message_id === "m8");
  assert.equal(kept.record, before.get("m8"));
});

test("rehydrate writes message text back into the room row and drops the side records", t => {
  const room = open(t, { sideTableMessages: true });
  const body = text("back");
  room.post("m0", body);
  assert.equal(room.raw().includes(body), false);
  assert.equal(room.store.rehydrateAllProjections(), 1);
  assert.match(room.raw(), /back-xxxx/);
  assert.equal(room.records().length, 0);
  assert.equal(room.store.room("commons").state.messages.find(message => message.id === "m0").body, body);
});
