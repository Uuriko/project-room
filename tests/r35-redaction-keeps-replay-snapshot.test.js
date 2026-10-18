import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { JOBS } from "../server/jobs.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// r35: an old stored event that today's reducer would reject (a write from
// before a validation tightening) is harmless while the messages backfill
// resumes from its saved replay snapshot: only events after the snapshot
// are replayed. Deleting any message nulled that snapshot
// (commitMessageRedaction), so the next backfill replayed the room's whole
// log from sequence 0, hit the old event, and parked the room for good —
// the integrity job then reports messages_backfill_failed /
// integrity_mismatch on every tick (prod since 2026-10-11 20:30Z has that
// exact signature). The redaction now redacts the message inside the
// snapshot instead of discarding it, so a delete no longer forces a
// full replay, and the snapshot still holds none of the deleted text.

const integrityJob = JOBS.find(job => job.name === "integrity");

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "r35-redaction-snapshot-"));
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

// Rewrite one already-replayed event into a shape the current reducer
// rejects, the way a validation tightening leaves a legacy write behind.
// The projection is left as the live writer built it.
function ageIntoLegacyShape(store, messageId) {
  const row = store.db.prepare("SELECT sequence, body FROM events WHERE room_id='commons' AND body LIKE ?").get(`%"messageId":"${messageId}"%`);
  const stored = JSON.parse(row.body);
  // A body over today's 65,536-character cap: accepted when it was written.
  stored.data.body = "legacy ".repeat(10_000);
  store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(JSON.stringify(stored), row.sequence);
  return row.sequence;
}

function backfillFailures(store) {
  return store.integrityFailures().filter(row => row.step === "messages_backfill").map(row => ({ ...row }));
}

async function integrityTick(store) {
  // Run enough deferred-batch visits that the backfill step is reached.
  let last;
  for (let i = 0; i < 6; i += 1) last = await integrityJob.run(store, { deadline: Date.now() + 60_000 });
  return last;
}

test("fixture guard: an incremental backfill past an aged event stays green", async t => {
  const { store, cmd } = open(t);
  cmd(T.MESSAGE_POSTED, { messageId: "old", body: "written before the tightening" });
  cmd(T.MESSAGE_POSTED, { messageId: "keep", body: "keep me" });
  assert.equal(backfillAll(store).done, true);
  ageIntoLegacyShape(store, "old");
  cmd(T.MESSAGE_POSTED, { messageId: "later", body: "after" });
  const result = backfillAll(store);
  assert.equal(result.done, true);
  assert.deepEqual(result.blocked, []);
  const tick = await integrityTick(store);
  assert.equal(tick.scanError, undefined, JSON.stringify(tick));
  assert.deepEqual(backfillFailures(store), []);
});

test("deleting a message does not force a full replay that parks the room", async t => {
  const { store, cmd } = open(t);
  cmd(T.MESSAGE_POSTED, { messageId: "old", body: "written before the tightening" });
  cmd(T.MESSAGE_POSTED, { messageId: "secret", body: "r35-deleted-needle-5e1" });
  cmd(T.MESSAGE_EDITED, { messageId: "secret", body: "r35-deleted-needle-5e2", expectedMessageRevision: 0 });
  assert.equal(backfillAll(store).done, true);
  ageIntoLegacyShape(store, "old");
  cmd(T.MESSAGE_DELETED, { messageId: "secret", expectedMessageRevision: 1, reason: "remove" });
  cmd(T.MESSAGE_POSTED, { messageId: "later", body: "after the delete" });

  const result = backfillAll(store);
  assert.deepEqual(result.blocked, [], "a delete must not park the room");
  assert.equal(result.done, true);
  const tick = await integrityTick(store);
  assert.equal(tick.scanError, undefined, `integrity went red: ${tick.scanError} ${JSON.stringify(tick.failureDetail)}`);
  assert.deepEqual(backfillFailures(store), []);
});

test("the kept replay snapshot holds none of the deleted text", async t => {
  const { store, cmd } = open(t);
  cmd(T.MESSAGE_POSTED, { messageId: "secret", body: "r35-deleted-needle-6a1" });
  cmd(T.MESSAGE_POSTED, { messageId: "root", body: "root" });
  cmd(T.MESSAGE_POSTED, { messageId: "reply", body: "r35-deleted-needle-6a3", replyToId: "root", alsoSendToChannel: true });
  cmd(T.MESSAGE_EDITED, { messageId: "secret", body: "r35-deleted-needle-6a2", expectedMessageRevision: 0 });
  assert.equal(backfillAll(store).done, true);
  const before = store.db.prepare("SELECT state_json FROM messages_backfill_cursor WHERE room_id='commons'").get().state_json;
  assert.ok(before.includes("r35-deleted-needle-6a2"), "positive control: the snapshot carries the live text");
  cmd(T.MESSAGE_DELETED, { messageId: "secret", expectedMessageRevision: 1, reason: "remove" });
  cmd(T.MESSAGE_DELETED, { messageId: "reply", expectedMessageRevision: 0, reason: "remove" });
  const cursor = store.db.prepare("SELECT state_json FROM messages_backfill_cursor WHERE room_id='commons'").get();
  assert.equal(typeof cursor.state_json, "string", "the snapshot is kept, redacted, instead of discarded");
  for (const needle of ["r35-deleted-needle-6a1", "r35-deleted-needle-6a2", "r35-deleted-needle-6a3"]) {
    assert.equal(String(cursor.state_json ?? "").includes(needle), false, `snapshot still holds ${needle}`);
  }
  // The kept snapshot resumes and the room certifies against the projection.
  assert.equal(backfillAll(store).done, true);
  const parity = store.checkMessagesParity?.();
  if (parity !== undefined) assert.ok(!parity?.error, JSON.stringify(parity));
});

test("a short deleted text does not discard the snapshot by matching unrelated strings", async t => {
  const { store, cmd } = open(t);
  cmd(T.MESSAGE_POSTED, { messageId: "old", body: "written before the tightening" });
  cmd(T.MESSAGE_POSTED, { messageId: "short", body: "y" });
  assert.equal(backfillAll(store).done, true);
  ageIntoLegacyShape(store, "old");
  cmd(T.MESSAGE_DELETED, { messageId: "short", expectedMessageRevision: 0, reason: "remove" });
  const cursor = store.db.prepare("SELECT state_json FROM messages_backfill_cursor WHERE room_id='commons'").get();
  assert.equal(typeof cursor.state_json, "string");
  const result = backfillAll(store);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(backfillFailures(store), []);
});

test("a deleted text still present elsewhere in the snapshot discards it, as before", async t => {
  const { store, cmd } = open(t);
  cmd(T.MESSAGE_POSTED, { messageId: "secret", body: "r35-quoted-needle-7c1" });
  cmd(T.MESSAGE_POSTED, { messageId: "quote", body: "someone said r35-quoted-needle-7c1 earlier" });
  assert.equal(backfillAll(store).done, true);
  cmd(T.MESSAGE_DELETED, { messageId: "secret", expectedMessageRevision: 0, reason: "remove" });
  const cursor = store.db.prepare("SELECT state_json, state_seq FROM messages_backfill_cursor WHERE room_id='commons'").get();
  assert.equal(cursor.state_json, null);
  assert.equal(cursor.state_seq, 0);
  assert.equal(backfillAll(store).done, true);
});
