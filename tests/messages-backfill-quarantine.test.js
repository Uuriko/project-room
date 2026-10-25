import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event } from "../src/events.js";
import { JOBS } from "../server/jobs.mjs";
import { runCronJobs, applyOutcomes, jobHealthView } from "../cloudflare/job-heartbeat.mjs";

// Oct 11: one messages_backfill_blocks row (a stored event the reducer
// rejects) failed the integrity job on every tick and parked the room, so
// nothing could certify its messages or shed the projection. The event is
// quarantined, the room still fills, and the public health view names the
// reason and component only.

const integrity = JOBS.find(job => job.name === "integrity");
const roomId = "quiet-room";
const body = "legacy text the reducer rejected";

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-backfill-quarantine-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function at(offset) {
  return new Date(Date.UTC(2026, 9, 11) + offset * 1000).toISOString();
}

test("one rejected event is quarantined, the room still fills, and health names only the reason", async t => {
  const store = open(t);
  store.initialize([
    ...initialRoom(roomId),
    event({ type: T.MESSAGE_POSTED, actorId: "owner", roomId, id: "ev-old", idempotencyKey: "ev-old-key", at: at(1),
      data: { messageId: "kept", body } }),
    event({ type: T.MESSAGE_POSTED, actorId: "owner", roomId, id: "ev-tail", idempotencyKey: "ev-tail-key", at: at(2),
      data: { messageId: "tail", body: "after" } })
  ]);
  const row = store.db.prepare("SELECT body FROM events WHERE id='ev-old'").get();
  const stored = JSON.parse(row.body);
  stored.data.messageId = "bad id@x";
  store.db.prepare("UPDATE events SET body=? WHERE id='ev-old'").run(JSON.stringify(stored));
  const projection = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId).projection);
  projection.messages.find(message => message.id === "kept").id = "bad id@x";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), roomId);

  const filled = store.backfillMessages({ limit: 1000 });
  assert.equal(filled.done, true);
  assert.deepEqual(filled.blocked, []);
  assert.equal(filled.quarantined.length, 1);
  assert.equal(store.db.prepare("SELECT body FROM events WHERE id='ev-old'").get().body.includes("bad id@x"), true);
  const messages = store.db.prepare("SELECT message_id, body FROM messages WHERE room_id=? ORDER BY message_id").all(roomId);
  assert.deepEqual(messages.map(message => message.message_id), ["bad id@x", "tail"]);
  assert.equal(messages.find(message => message.message_id === "bad id@x").body, body);

  const atMs = Date.now();
  const outcomes = await runCronJobs({
    integrity: () => integrity.run(store, { deadline: atMs + 5000 })
  }, { now: () => atMs, log() {} });
  const storedHealth = applyOutcomes({}, outcomes);
  const view = jobHealthView(storedHealth, atMs).jobs.find(job => job.name === "integrity");
  assert.equal(view.status, "degraded");
  assert.equal(view.degraded, "one_quarantined_event");
  assert.equal(view.quarantineEventId, "ev-old");
  assert.equal(view.failingSince, null);
  assert.match(view.action, /quarantined/);
  assert.equal(view.consecutiveFailures, 0);
  assert.equal(view.lastSummary.blockedRooms, 0);
  assert.equal(view.lastSummary.quarantinedEvents, 1);
  assert.equal(view.lastSummary.blockReason, "reducer_rejected");
  assert.equal(view.lastSummary.blockComponent, "messages");
  const printed = JSON.stringify(view);
  assert.equal(printed.includes(roomId), false);
  assert.equal(printed.includes(body), false);
  assert.equal(printed.includes("bad id@x"), false);
});
