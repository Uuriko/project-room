import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { operatorStatus } from "../server/operator-status.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// r35: a red integrity job names the parked room (#3624), but the stored
// failure line is allowlisted ("messages_backfill integrity check failed"),
// so the event to repair and the reducer's reason were nowhere an operator
// could read them. The operator status now lists the parked rooms with the
// blocking sequence, event id and reason.

test("operator status lists each parked room with the blocking event and reason", t => {
  const directory = mkdtempSync(join(tmpdir(), "r35-operator-blocks-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "old", body: "legacy" } });
  assert.deepEqual(operatorStatus(store).messagesBackfillBlocks, []);
  const row = store.db.prepare("SELECT sequence, id, body FROM events WHERE room_id='commons' AND body LIKE '%\"messageId\":\"old\"%'").get();
  const stored = JSON.parse(row.body);
  stored.data.body = "legacy ".repeat(10_000);
  store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(JSON.stringify(stored), row.sequence);
  store.backfillMessages({ limit: 400 });
  const blocks = operatorStatus(store).messagesBackfillBlocks;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].roomId, "commons");
  assert.equal(blocks[0].sequence, row.sequence);
  assert.equal(blocks[0].eventId, row.id);
  assert.equal(blocks[0].error, "body must be at most 65536 characters");
  assert.equal(typeof blocks[0].headSeq, "number");
});
