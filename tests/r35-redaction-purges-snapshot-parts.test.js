import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// r35 follow-up: when a redaction keeps the replay snapshot (redacted in
// place), split-snapshot parts left in messages_backfill_state from a large
// pre-redaction write (research r21) still hold the removed text. The keep
// path now purges the room's parts the way the discard path already did. The
// table exists only once the split-snapshot schema lands, so this test
// creates it, and the purge tolerates its absence.

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "r35-purge-parts-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  return { store, cmd };
}

function backfillAll(store) {
  let result;
  for (let i = 0; i < 20; i += 1) {
    result = store.backfillMessages({ limit: 400 });
    if (result.done) break;
  }
  return result;
}

test("a kept, redacted snapshot purges leftover split-snapshot parts", t => {
  const { store, cmd } = open(t);
  cmd(T.MESSAGE_POSTED, { messageId: "secret", body: "r35-part-needle-91" });
  cmd(T.MESSAGE_POSTED, { messageId: "keep", body: "keep me" });
  assert.equal(backfillAll(store).done, true);
  store.db.prepare(`CREATE TABLE IF NOT EXISTS messages_backfill_state (
  room_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (room_id, part)
)`).run();
  store.db.prepare("INSERT INTO messages_backfill_state (room_id, part, json) VALUES ('commons', 0, ?)").run(JSON.stringify({ messages: [{ id: "secret", body: "r35-part-needle-91" }] }));
  cmd(T.MESSAGE_DELETED, { messageId: "secret", expectedMessageRevision: 0, reason: "remove" });
  const cursor = store.db.prepare("SELECT state_json FROM messages_backfill_cursor LEFT JOIN message_replay_snapshots USING(room_id) WHERE room_id='commons'").get();
  assert.equal(typeof cursor.state_json, "string", "the snapshot is kept, redacted");
  assert.equal(String(cursor.state_json).includes("r35-part-needle-91"), false, "kept snapshot holds the needle");
  const parts = store.db.prepare("SELECT COUNT(*) AS n FROM messages_backfill_state WHERE room_id='commons'").get().n;
  assert.equal(parts, 0, "split-snapshot parts survive the kept redaction");
});
