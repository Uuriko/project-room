import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event, replay } from "../src/events.js";

// A stored event the current reducer rejects (written before a validation
// tightening, or by a path that bypassed it) used to wedge the messages
// backfill forever: fillRoom threw on the same chunk every tick, the throw
// aborted the whole sweep, and one row in messages_backfill_blocks then
// parked the whole room. The backfill now quarantines that event (the row
// stays, the serving projection's copy is what the table publishes) and
// keeps filling the room and every other room. A log that ends before the
// room head still parks the room.

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-messages-backfill-blocks-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function at(offset) {
  return new Date(Date.UTC(2026, 9, 2) + offset * 1000).toISOString();
}

function messageEvent(roomId, id, type, data, offset) {
  return event({
    type, actorId: "owner", roomId, id, idempotencyKey: `${id}-key`, at: at(offset), data
  });
}

function rows(store, roomId) {
  return store.db.prepare("SELECT * FROM messages WHERE room_id=? ORDER BY message_id").all(roomId);
}

function blocks(store) {
  // Spread into plain objects: node:sqlite rows carry a different prototype
  // and would fail deepStrictEqual against literals despite equal fields.
  return store.db.prepare("SELECT room_id, sequence, event_id, error FROM messages_backfill_blocks ORDER BY room_id").all()
    .map(row => ({ ...row }));
}

// Seed a room whose log and projection agree the way a legacy writer left
// them: a valid stand-in message is initialized normally, then the stored
// event body and the projected message are rewritten in place to the poison
// shape (an invalid messageId the current envelope validator rejects).
function poisonedRoom(store, roomId) {
  store.initialize([
    ...initialRoom(roomId),
    messageEvent(roomId, "ev-standin", T.MESSAGE_POSTED, { messageId: "standin", body: "legacy text" }, 10),
    messageEvent(roomId, "ev-tail", T.MESSAGE_POSTED, { messageId: "tail", body: "after the poison" }, 11)
  ]);
  const row = store.db.prepare("SELECT sequence, body FROM events WHERE id='ev-standin'").get();
  const stored = JSON.parse(row.body);
  stored.data.messageId = "bad id@x";
  store.db.prepare("UPDATE events SET body=? WHERE id='ev-standin'").run(JSON.stringify(stored));
  const roomRow = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  const projection = JSON.parse(roomRow.projection);
  projection.messages.find(message => message.id === "standin").id = "bad id@x";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), roomId);
  return row.sequence;
}

test("fixture guard: the poisoned log still rejects raw replay", t => {
  const store = open(t);
  poisonedRoom(store, "aaa");
  const bodies = store.db.prepare("SELECT body FROM events WHERE room_id='aaa' ORDER BY sequence").all()
    .map(row => JSON.parse(row.body));
  assert.throws(() => replay(bodies), /Invalid messageId/);
});

test("a poisoned room is parked by name and healthy rooms still backfill", t => {
  const store = open(t);
  const poisonSeq = poisonedRoom(store, "aaa");
  store.initialize([
    ...initialRoom("zzz"),
    messageEvent("zzz", "ev-z1", T.MESSAGE_POSTED, { messageId: "z1", body: "z first" }, 10),
    messageEvent("zzz", "ev-z2", T.MESSAGE_POSTED, { messageId: "z2", body: "z second" }, 11)
  ]);

  const accusation = { roomId: "aaa", sequence: poisonSeq, eventId: "ev-standin", error: "Invalid messageId" };
  const first = store.backfillMessages({ limit: 1000 });
  assert.equal(first.done, true);
  assert.deepEqual(first.blocked, []);
  assert.deepEqual(first.quarantined, [{ ...accusation, fresh: true }]);
  assert.deepEqual(blocks(store), [{ room_id: "aaa", sequence: poisonSeq, event_id: "ev-standin", error: "Invalid messageId" }]);
  assert.equal(store.db.prepare("SELECT skipped, reason, component FROM messages_backfill_blocks WHERE room_id='aaa'").get().skipped, 1);
  assert.equal(rows(store, "zzz").length, 2, "the healthy room's rows are written");
  assert.deepEqual(rows(store, "aaa").map(row => row.message_id), ["bad id@x", "tail"],
    "the tail is replayed and the rejected message is kept from the serving projection");
  assert.match(store.db.prepare("SELECT body FROM events WHERE id='ev-standin'").get().body, /bad id@x/,
    "the rejected event row stays in the log");

  const second = store.backfillMessages({ limit: 1000 });
  assert.equal(second.done, true);
  assert.deepEqual(second.quarantined, [{ ...accusation, fresh: false }]);

  const parity = store.checkMessagesParity();
  assert.equal(parity.ok, true);
  const other = store.checkMessagesParity();
  assert.equal(other.ok, true);
});

test("the deferred batch keeps moving when one event is quarantined", async t => {
  const store = open(t);
  poisonedRoom(store, "aaa");
  let completed = 0;
  for (let i = 0; i < 12; i += 1) {
    await store.runDeferredIntegrityBatch({});
    completed += 1;
  }
  assert.equal(completed, 12, "every tick completes");
  const recorded = store.db.prepare(
    "SELECT record_id AS recordId FROM integrity_failures WHERE step='messages_backfill' AND record_id<>''"
  ).all();
  assert.deepEqual(recorded, [], "a quarantined event is not a per-room integrity failure");
  const row = store.db.prepare("SELECT skipped, reason, component FROM messages_backfill_blocks WHERE room_id='aaa'").get();
  assert.equal(row.skipped, 1);
  assert.equal(row.reason, "reducer_rejected");
  assert.equal(row.component, "messages");
});

test("a head sequence the log no longer reaches parks the room with the stopped-at reason", t => {
  const store = open(t);
  store.initialize([
    ...initialRoom("gap"),
    messageEvent("gap", "ev-g1", T.MESSAGE_POSTED, { messageId: "g1", body: "one" }, 10)
  ]);
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id='gap'").get().sequence;
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='gap'").run(head + 2);
  const result = store.backfillMessages({ limit: 1000 });
  assert.equal(result.done, true);
  assert.deepEqual(result.blocked, [{
    roomId: "gap", sequence: head, eventId: null,
    error: `messages backfill stopped at ${head} before room gap reached sequence ${head + 2}`, fresh: true
  }]);
  assert.deepEqual(blocks(store).map(row => row.room_id), ["gap"]);
});

test("a cooperative interruption still propagates and never parks the room", t => {
  const store = open(t);
  const seeded = [...initialRoom("live")];
  for (let i = 0; i < 30; i += 1) {
    seeded.push(messageEvent("live", `ev-live-${i}`, T.MESSAGE_POSTED, { messageId: `live-${i}`, body: `line ${i}` }, 10 + i));
  }
  store.initialize(seeded);
  assert.throws(
    () => store.backfillMessages({ limit: 100, yieldBetween: () => { throw new Error("interrupted"); } }),
    /interrupted/
  );
  assert.deepEqual(blocks(store), [], "an operational throw is not a data block");
  const cursor = store.db.prepare("SELECT applied_seq,state_seq FROM messages_backfill_cursor WHERE room_id='live'").get();
  assert.equal(cursor.applied_seq,0);
  assert.ok(cursor.state_seq > 0, "the staged replay prefix survives interruption");
  const result = store.backfillMessages({ limit: 1000 });
  assert.equal(result.done, true);
  assert.equal(rows(store, "live").length, 30);
});

test("replacing the log with importEvents clears the block and the room backfills", t => {
  const store = open(t);
  poisonedRoom(store, "aaa");
  store.backfillMessages({ limit: 1000 });
  assert.equal(blocks(store).length, 1);
  const owner = store.issueAccessKey("aaa", "owner");
  const lines = store.db.prepare("SELECT sequence, body FROM events WHERE room_id='aaa' ORDER BY sequence").all()
    .map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
  lines.find(line => line.event.id === "ev-standin").event.data.messageId = "repaired";
  store.importEvents(owner, "aaa", lines);
  assert.deepEqual(blocks(store), [], "the block described the replaced log and does not carry");
  const result = store.backfillMessages({ limit: 1000 });
  assert.equal(result.done, true);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(rows(store, "aaa").map(row => row.message_id), ["repaired", "tail"]);
  const parity = store.checkMessagesParity();
  assert.equal(parity.ok, true);
  assert.equal(parity.roomId, "aaa");
});
