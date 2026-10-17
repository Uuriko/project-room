// research r41: when many rooms stop replaying in one backfill call (the
// class behind the Oct 11 messages_backfill wedge: a reducer change that
// rejects an old stored event), runMessagesBackfill passes every room it
// parked so far to nextRoom as a NOT IN list. Past 100 parked rooms in one
// call, that list exceeds the Worker's 100-value Durable Object SQL limit and
// the whole call throws instead of parking. Parked rooms are already excluded
// by the messages_backfill_blocks NOT EXISTS clause, so the list is redundant.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { runMessagesBackfill } from "../server/messages-store.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

process.env.ROOM_SQL_BIND_LIMIT = "100";

function poisonedRooms(t, count) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  for (let i = 0; i < count; i++) {
    const roomId = `poison-${String(i).padStart(3, "0")}`;
    store.initialize(initialRoom(roomId, "owner"));
    const key = store.issueAccessKey(roomId, "owner");
    store.command(key, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `m-${i}`, body: "hello" } });
    // A stored event the current reducer rejects (same shape as a log written
    // by an older reducer): its actor is no longer a member.
    const row = store.db.prepare("SELECT rowid, body FROM events WHERE room_id=? ORDER BY sequence DESC LIMIT 1").get(roomId);
    const body = JSON.parse(row.body);
    body.actorId = "someone-who-never-joined";
    store.db.prepare("UPDATE events SET body=? WHERE rowid=?").run(JSON.stringify(body), row.rowid);
  }
  store.db.prepare("DELETE FROM messages_backfill_cursor").run();
  store.db.prepare("DELETE FROM messages").run();
  return store;
}

test("the Worker bind limit is enforced in this file", (t) => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const values = Array.from({ length: 101 }, (_, i) => i);
  assert.throws(() => store.db.prepare(`SELECT 1 WHERE 1 IN (${values.map(() => "?").join(",")})`).get(...values),
    /too many SQL variables/);
});

for (const count of [100, 101, 130]) {
  test(`${count} rooms that stop replaying in one call are all parked by name`, (t) => {
    const store = poisonedRooms(t, count);
    const result = runMessagesBackfill(store, { limit: 1000 });
    assert.equal(result.failed.length, count);
    assert.equal(result.blocked.length, count);
    assert.equal(result.done, true);
  });
}
