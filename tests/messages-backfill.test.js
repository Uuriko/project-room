import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { DatabaseSync } from "node:sqlite";
import { fenceDefinitions } from "../server/writer-fence.mjs";
import { EVENT_TYPES as T, event } from "../src/events.js";

// initialize and importEvents do not write message rows. The backfill is the
// path that fills those rows, continues after a stop in the middle of a
// batch, and refuses a second copy of a row the command path already wrote.

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-messages-backfill-"));
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

function finish(store) {
  let guard = 0;
  let result;
  do {
    result = store.backfillMessages({ limit: 400 });
    assert.equal(result.budgetExceeded, false);
  } while (!result.done && ++guard < 200);
  assert.equal(result.done, true);
  return result;
}

function rows(store, roomId) {
  return store.db.prepare("SELECT * FROM messages WHERE room_id=? ORDER BY message_id").all(roomId);
}

test("backfill replays initialize and importEvents, and a second pass does not add rows", t => {
  const store = open(t);
  const roomId = "commons";
  store.initialize([
    ...initialRoom(roomId),
    messageEvent(roomId, "ev-topic", T.MESSAGE_POSTED, { messageId: "topic", body: "Topic" }, 10),
    messageEvent(roomId, "ev-edit", T.MESSAGE_EDITED, { messageId: "topic", body: "Topic revised", expectedMessageRevision: 0 }, 11),
    messageEvent(roomId, "ev-reply", T.MESSAGE_POSTED, {
      messageId: "reply", body: "Reply", replyToId: "topic", alsoSendToChannel: true
    }, 12),
    messageEvent(roomId, "ev-delete", T.MESSAGE_DELETED, { messageId: "topic", expectedMessageRevision: 1 }, 13)
  ]);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages").get().n, 0, "initialize does not double-write");
  const stalled = store.backfillMessages({ deadline: 0 });
  assert.equal(stalled.budgetExceeded, true);
  assert.equal(stalled.events, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages_backfill_cursor WHERE room_id=?").get(roomId).n, 0);

  finish(store);
  const state = store.room(roomId).state;
  const written = rows(store, roomId);
  assert.equal(written.length, state.messages.length);
  assert.equal(written.length, 3);
  const topic = written.find(row => row.message_id === "topic");
  const postSeq = store.db.prepare("SELECT sequence FROM events WHERE id='ev-topic'").get().sequence;
  assert.equal(topic.seq, postSeq);
  assert.equal(topic.body, null);
  assert.equal(typeof topic.deleted_at, "string");
  assert.ok(written.some(row => row.message_id === "reply:channel"));
  const parity = store.checkMessagesParity();
  assert.equal(parity.ok, true);
  assert.equal(parity.checked, 1);
  assert.equal(parity.roomId, roomId);
  assert.equal(parity.projectionCount, parity.tableCount);
  assert.equal(parity.projectionLastSeq, parity.tableLastSeq);
  assert.equal(parity.tableLastSeq, store.db.prepare("SELECT sequence FROM events WHERE id='ev-reply'").get().sequence);

  const again = finish(store);
  assert.equal(again.events, 0);
  assert.deepEqual(rows(store, roomId), written);

  store.db.prepare("DELETE FROM messages_backfill_cursor WHERE room_id=?").run(roomId);
  finish(store);
  assert.deepEqual(rows(store, roomId), written);

  store.db.prepare("DELETE FROM messages WHERE message_id='reply'").run();
  store.db.prepare("UPDATE messages_backfill_cursor SET sweep_after='' WHERE room_id=''").run();
  assert.throws(() => store.checkMessagesParity(), /messages parity failed for commons: projection count 3, table count 2/);
  store.db.prepare("DELETE FROM messages_backfill_cursor WHERE room_id=?").run(roomId);
  finish(store);
  assert.equal(rows(store, roomId).length, 3);
  const repaired = store.checkMessagesParity();
  assert.equal(repaired.tableCount, 3);
  assert.equal(repaired.projectionLastSeq, repaired.tableLastSeq);

  const owner = store.issueAccessKey(roomId, "owner");
  const kept = store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence LIMIT 2").all(roomId)
    .map(row => JSON.parse(row.body));
  const imported = messageEvent(roomId, "ev-import", T.MESSAGE_POSTED, { messageId: "imported", body: "from import" }, 20);
  const lines = [...kept, imported].map((entry, index) => ({ sequence: index + 1, event: entry }));
  store.importEvents(owner, roomId, lines);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE message_id='topic'").get().n, 1, "importEvents leaves existing rows");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE message_id='imported'").get().n, 0);
  finish(store);
  const afterImport = rows(store, roomId);
  assert.deepEqual(afterImport.map(row => row.message_id), ["imported"]);
  assert.equal(afterImport[0].body, "from import");
  const importedParity = store.checkMessagesParity();
  assert.equal(importedParity.projectionCount, 1);
  assert.equal(importedParity.tableCount, 1);
  assert.equal(importedParity.projectionLastSeq, importedParity.tableLastSeq);
  const quiet = store.backfillMessages({ limit: 400 });
  assert.equal(quiet.done, true);
  assert.equal(quiet.events, 0);
  assert.deepEqual(rows(store, roomId), afterImport);
  // Counts and order alone miss a corrupted current record. The storage
  // parity owner must reject both record content and indexed visibility drift.
  for (const change of ["body='wrong text'", "author_id='wrong-author'", "channel_id='wrong-channel'"]) {
    store.db.prepare(`UPDATE messages SET ${change} WHERE message_id='imported'`).run();
    assert.throws(() => store.checkMessagesParity(), /messages parity failed.*record/);
    assert.equal(store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId).parity_at_seq, null);
    store.db.prepare("DELETE FROM messages_backfill_cursor WHERE room_id=?").run(roomId);
    finish(store);
  }
  store.db.prepare("UPDATE messages SET record_json=json_set(record_json,'$.revision',999) WHERE message_id='imported'").run();
  assert.throws(() => store.checkMessagesParity(), /messages parity failed.*record/);
  store.db.prepare("DELETE FROM messages_backfill_cursor WHERE room_id=?").run(roomId);
  finish(store);
  store.checkMessagesParity();
  // Replacement can keep the same head id/sequence while changing earlier
  // content. An old replay snapshot/certification must never survive import.
  const replacement = store.db.prepare("SELECT sequence,body FROM events WHERE room_id=? ORDER BY sequence").all(roomId)
    .map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
  replacement.at(-1).event.data.body = 'replacement with unchanged event id';
  store.importEvents(owner, roomId, replacement);
  assert.equal(store.checkMessagesParity().checked, 0);
  finish(store);
  assert.equal(store.checkMessagesParity().checked, 1);
  assert.equal(JSON.parse(rows(store, roomId)[0].record_json).body, 'replacement with unchanged event id');
});

// Authoring gate: real v37 storage upgrade, previously opened writer and
// persisted replay cursor. Existing old-version tests lack this column and
// populated message backfill. Synthetic downgrade only; no production seam.
test('v37 message records migrate lazily, replay populated cursors, and fence old writers', t => {
  const directory = mkdtempSync(join(tmpdir(), 'project-room-message-v38-'));
  const filename = join(directory, 'room.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = new RoomStore(filename);
  seed.initialize([...initialRoom('commons'), messageEvent('commons', 'ev-legacy', T.MESSAGE_POSTED, {messageId:'legacy', body:'retained legacy text'}, 2)]);
  finish(seed);
  for (const row of seed.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v38_*'").all()) seed.db.exec(`DROP TRIGGER ${row.name}`);
  if (seed.db.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name='record_json'").get()) seed.db.exec('ALTER TABLE messages DROP COLUMN record_json');
  for (const {name,sql} of fenceDefinitions(37)) if (!seed.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name)) seed.db.exec(sql);
  seed.db.exec('PRAGMA user_version=37');
  seed.close();
  const old = new DatabaseSync(filename);
  old.function('project_room_writer_v37',()=>37);
  const oldWrite = old.prepare("UPDATE messages SET body=body WHERE message_id='legacy'");
  oldWrite.run();
  const current = new RoomStore(filename);
  try {
    assert.equal(current.db.prepare('PRAGMA user_version').get().user_version,38);
    assert.equal(current.db.prepare("SELECT record_json FROM messages WHERE message_id='legacy'").get().record_json,null);
    assert.throws(()=>oldWrite.run(),/project_room_writer_v38|unsupported database writer/);
    assert.equal(current.checkMessagesParity().checked,0,'uncertified legacy rows are not ready');
    finish(current);
    assert.equal(JSON.parse(current.db.prepare("SELECT record_json FROM messages WHERE message_id='legacy'").get().record_json).body,'retained legacy text');
    assert.equal(current.checkMessagesParity().checked,1);
  } finally { current.close(); old.close(); }
  const reopened = new RoomStore(filename);
  try { assert.equal(JSON.parse(reopened.db.prepare("SELECT record_json FROM messages WHERE message_id='legacy'").get().record_json).body,'retained legacy text'); }
  finally {reopened.close();}
});

test("a command row stays one row when the backfill replays that event", t => {
  const store = open(t);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const saved = store.command(owner, "commons", {
    id: "cmd-live", type: T.MESSAGE_POSTED, data: { messageId: "live", body: "from the command" }
  });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE message_id='live'").get().n, 1);
  finish(store);
  const row = store.db.prepare("SELECT seq, body FROM messages WHERE message_id='live'").get();
  assert.equal(row.seq, saved.sequence);
  assert.equal(row.body, "from the command");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE message_id='live'").get().n, 1);
});

test("backfill resumes after a mid-batch interruption and passes parity on a 10k-message room", t => {
  const store = open(t);
  const roomId = "bulk";
  const count = 10000;
  const events = initialRoom(roomId);
  for (let i = 0; i < count; i += 1) {
    events.push(messageEvent(roomId, `ev-${i}`, T.MESSAGE_POSTED, { messageId: `m${i}`, body: `line ${i}` }, i + 1));
  }
  store.initialize(events);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
  const sequence = store.room(roomId).sequence;
  assert.throws(() => store.backfillMessages({
    limit: 400,
    yieldBetween: () => { throw new Error("interrupted"); }
  }), /interrupted/);
  const cursor = store.db.prepare("SELECT applied_seq, state_seq, applied_event_id FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
  assert.ok(cursor.applied_seq > 0);
  assert.ok(cursor.applied_seq < sequence);
  assert.equal(cursor.state_seq, cursor.applied_seq);
  const partial = store.db.prepare("SELECT count(*) AS n, count(DISTINCT message_id) AS ids FROM messages WHERE room_id=?").get(roomId);
  const posted = store.db.prepare(`SELECT count(*) AS n FROM events
    WHERE room_id=? AND sequence<=? AND json_extract(body, '$.type')='message.posted'`).get(roomId, cursor.applied_seq).n;
  assert.equal(partial.n, posted);
  assert.equal(partial.ids, posted);
  assert.ok(partial.n > 0);
  assert.ok(partial.n < count);

  finish(store);
  const parity = store.checkMessagesParity();
  assert.equal(parity.ok, true);
  assert.equal(parity.roomId, roomId);
  assert.equal(parity.projectionCount, count);
  assert.equal(parity.tableCount, count);
  assert.equal(parity.projectionLastSeq, parity.tableLastSeq);
  assert.equal(parity.tableLastSeq, store.db.prepare(`SELECT MAX(sequence) AS n FROM events
    WHERE room_id=? AND json_extract(body, '$.type')='message.posted'`).get(roomId).n);
  const sample = store.db.prepare("SELECT message_id, body FROM messages WHERE room_id=? AND message_id IN ('m0', 'm9999') ORDER BY message_id").all(roomId);
  assert.deepEqual(sample.map(row => ({ message_id: row.message_id, body: row.body })), [
    { message_id: "m0", body: "line 0" },
    { message_id: "m9999", body: "line 9999" }
  ]);
  const signature = store.db.prepare("SELECT count(*) AS n, COALESCE(MAX(seq), 0) AS lastSeq FROM messages WHERE room_id=?").get(roomId);
  const quiet = store.backfillMessages({ limit: 400 });
  assert.equal(quiet.done, true);
  assert.equal(quiet.events, 0);
  assert.deepEqual(store.db.prepare("SELECT count(*) AS n, COALESCE(MAX(seq), 0) AS lastSeq FROM messages WHERE room_id=?").get(roomId), signature);
});

test("the integrity cron replays an initialize room until the parity check passes", async t => {
  const store = open(t);
  const roomId = "cron";
  store.initialize([
    ...initialRoom(roomId),
    messageEvent(roomId, "ev-cron", T.MESSAGE_POSTED, { messageId: "cron-note", body: "from initialize" }, 3)
  ]);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
  let matched = null;
  for (let i = 0; i < 20 && !matched; i += 1) {
    await store.runDeferredIntegrityBatch({ yieldBetween: async () => {} });
    const cursor = store.db.prepare("SELECT applied_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
    if (cursor?.applied_seq === store.room(roomId).sequence) {
      const parity = store.checkMessagesParity();
      if (parity.checked === 1) matched = parity;
    }
  }
  assert.ok(matched, "the integrity steps reach the message backfill");
  assert.equal(matched.projectionCount, 1);
  assert.equal(matched.tableCount, 1);
  assert.equal(matched.projectionLastSeq, matched.tableLastSeq);
  assert.equal(store.db.prepare("SELECT body FROM messages WHERE message_id='cron-note'").get().body, "from initialize");
});
