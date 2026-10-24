// SPILL-1: messages archival gets its automatic caller — the
// messages-archive job. Exercises server/messages-archive.mjs (trigger
// math, dry-run reports, the tick), the messages-archive job in
// server/jobs.mjs, and the dry-run report fields added to
// archiveRoomMessages in server/messages-store.mjs.
//
// This suite supersedes the P0-6 suite of the same name. Two of that
// build's positions were reversed before landing, and the tests here pin
// the corrected ones: sizing derives from PILOT_LIMITS.projectionBytes
// (the 4 MiB cap the store itself enforces), NOT a claimed 2 MB Durable
// Object row limit; and there is no second operator route — the operator
// door that landed with #4123 (POST /api/operator/archive, plan-bound,
// self-certifying) is the only operator path, covered by
// tests/operator-archive.test.js.
//
// Every store here is a local shaped fixture: a real RoomStore on an
// in-memory database (the ":memory:" pattern other suites in this repo
// use), seeded through the replay path or the command path. Nothing in
// this file touches a live or production room.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event } from "../src/events.js";
import { messagesBackfillCaughtUp } from "../server/messages-store.mjs";
import {
  ARCHIVE_CAP_BYTES, ARCHIVE_CAP_BASIS, ARCHIVE_KEEP_NEWEST, archiveLiveOptedIn,
  archiveTriggerBytes, roomsOverArchiveTrigger, runMessagesArchiveTick, archiveDryRunReport
} from "../server/messages-archive.mjs";
import { jobByName, jobEnabled } from "../server/jobs.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

// A small certified room seeded through the command path.
function commandFixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "human", displayName: "human", kind: "human",
    permissions: ["accept_work", "complete_work", "verify"]
  }));
  const human = store.issueAccessKey("commons", "human");
  t.after(() => { store.close(); });
  const send = (body, id) => store.command(human, "commons", command(T.MESSAGE_POSTED, { messageId: id, body }, id));
  const certify = (roomId = "commons") => certifyRoom(store, roomId);
  return { store, human, send, certify };
}

function certifyRoom(store, roomId) {
  for (let i = 0; i < 40 && !messagesBackfillCaughtUp(store.db, roomId); i++) {
    store.backfillMessages({ limit: 1000 });
  }
  assert.equal(messagesBackfillCaughtUp(store.db, roomId), true, `${roomId} backfill caught up`);
  assert.equal(store.checkMessagesParity({ roomId }).ok, true, `${roomId} parity certified`);
}

const at = offset => new Date(Date.UTC(2026, 9, 2) + offset * 1000).toISOString();

function messageEvent(roomId, id, messageId, body, offset) {
  return event({
    type: T.MESSAGE_POSTED, actorId: "owner", roomId, id,
    idempotencyKey: `${id}-key`, at: at(offset), data: { messageId, body }
  });
}

// A room seeded through the replay path (store.initialize), the pattern
// the backfill suites use: `count` messages whose bodies are `bodyLength`
// filler characters, so the stored projection size is predictable.
function seedRoom(store, roomId, count, bodyLength, prefix) {
  const events = [...initialRoom(roomId)];
  for (let i = 0; i < count; i++) {
    events.push(messageEvent(roomId, `${prefix}-ev-${i}`, `${prefix}-${i}`, `${prefix} ${i} ` + "x".repeat(bodyLength), 100 + i));
  }
  store.initialize(events);
}

function projectionBytes(store, roomId) {
  return store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS bytes FROM rooms WHERE id=?").get(roomId).bytes;
}

function projectionMessageCount(store, roomId) {
  return store.room(roomId).state.messages.length;
}

test("trigger math: a quarter of PILOT_LIMITS.projectionBytes, and the basis is named", () => {
  assert.equal(ARCHIVE_CAP_BYTES, PILOT_LIMITS.projectionBytes);
  assert.equal(ARCHIVE_CAP_BYTES, 4 * 1024 * 1024);
  assert.equal(archiveTriggerBytes(), 1_048_576);
  assert.equal(archiveTriggerBytes(ARCHIVE_CAP_BYTES), Math.floor(ARCHIVE_CAP_BYTES * 0.25));
  assert.equal(ARCHIVE_CAP_BASIS, "pilot-limits-projection-bytes");
  assert.equal(ARCHIVE_KEEP_NEWEST, 2000);
  assert.equal(archiveLiveOptedIn({}), false);
  assert.equal(archiveLiveOptedIn({ ROOM_MESSAGES_ARCHIVE_LIVE: "1" }), true);
  assert.equal(archiveLiveOptedIn({ ROOM_MESSAGES_ARCHIVE_LIVE: "true" }), false);
  assert.equal(archiveLiveOptedIn({ ROOM_MESSAGES_ARCHIVE_LIVE: "" }), false);
});

test("archiveRoomMessages dry-run report carries timestamps and projection sizes, and moves nothing", t => {
  const f = commandFixture(t);
  for (let i = 0; i < 10; i++) f.send(`report body ${i}`, `r-${i}`);
  f.certify();
  const beforeCount = f.store.room("commons").state.messages.length;
  const plan = f.store.archiveMessages("commons", { keepNewest: 4 });
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.ok(plan.archived > 0 && plan.freedBytes > 0);
  const moving = f.store.room("commons").state.messages.slice(0, plan.archived);
  assert.equal(plan.oldestAt, moving[0].createdAt);
  assert.equal(plan.newestAt, moving[moving.length - 1].createdAt);
  assert.equal(plan.projectionBytesBefore, projectionBytes(f.store, "commons"));
  assert.ok(plan.resultingProjectionBytes < plan.projectionBytesBefore);
  assert.ok(Math.abs(plan.projectionBytesBefore - plan.resultingProjectionBytes - plan.freedBytes) < 512,
    "resulting size tracks the freed bytes (plus the small archive marker)");
  assert.equal(f.store.room("commons").state.messages.length, beforeCount, "dry run changes nothing");
  const done = f.store.archiveMessages("commons", { keepNewest: 4, dryRun: false });
  assert.equal(done.archived, plan.archived);
  const afterBytes = projectionBytes(f.store, "commons");
  assert.ok(Math.abs(afterBytes - plan.resultingProjectionBytes) < 512,
    `live result ${afterBytes} matches the dry-run prediction ${plan.resultingProjectionBytes}`);
});

test("roomsOverArchiveTrigger lists due rooms largest-first and skips small rooms", t => {
  const store = new RoomStore(":memory:");
  t.after(() => { store.close(); });
  seedRoom(store, "big-a", 2100, 420, "a");
  seedRoom(store, "big-b", 2050, 380, "b");
  seedRoom(store, "small", 10, 10, "s");
  const a = projectionBytes(store, "big-a");
  const b = projectionBytes(store, "big-b");
  assert.ok(a > b && b >= archiveTriggerBytes(), `fixture sizes hold (a=${a}, b=${b}, trigger=${archiveTriggerBytes()})`);
  const due = roomsOverArchiveTrigger(store);
  assert.deepEqual(due.map(room => room.roomId), ["big-a", "big-b"]);
  assert.deepEqual(due.map(room => room.projectionBytes), [a, b]);
});

test("archiveDryRunReport names the true cap basis and plans at keepNewest 2000", t => {
  const store = new RoomStore(":memory:");
  t.after(() => { store.close(); });
  seedRoom(store, "big-a", 2100, 420, "a");
  const before = projectionBytes(store, "big-a");
  const report = archiveDryRunReport(store, "big-a");
  assert.equal(report.ok, true);
  assert.equal(report.capBytes, ARCHIVE_CAP_BYTES);
  assert.equal(report.capBasis, "pilot-limits-projection-bytes");
  assert.equal(report.triggerBytes, 1_048_576);
  assert.equal(report.overTrigger, true);
  assert.equal(report.keepNewest, 2000);
  assert.equal(report.wouldArchive, 100);
  assert.equal(report.plan.oldestAt, store.room("big-a").state.messages[0].createdAt);
  assert.ok(report.plan.resultingProjectionBytes < before);
  assert.equal(projectionBytes(store, "big-a"), before, "a dry-run report moves no projection bytes");
  const missing = archiveDryRunReport(store, "no-such-room");
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "room_not_found");
});

describe("the messages-archive job", () => {
  test("registration: hourly, slow, both runtimes, enabled only while a room is due", t => {
    const job = jobByName("messages-archive");
    assert.ok(job, "job is registered");
    assert.equal(job.cadenceMs, 3600_000);
    assert.equal(job.slow, true);
    assert.deepEqual([...job.runtimes].sort(), ["node", "worker"]);
    const store = new RoomStore(":memory:");
    t.after(() => { store.close(); });
    store.initialize(initialRoom());
    assert.equal(jobEnabled(job, {}, store), false, "an idle store never wakes for it");
    seedRoom(store, "big-a", 2100, 420, "a");
    assert.equal(jobEnabled(job, {}, store), true, "a due room enables it");
  });

  test("dry-run posture: the tick reports what would move and moves nothing", t => {
    const store = new RoomStore(":memory:");
    t.after(() => { store.close(); });
    seedRoom(store, "big-a", 2100, 420, "a");
    const before = projectionBytes(store, "big-a");
    const result = runMessagesArchiveTick(store, { env: {} });
    assert.equal(result.dryRun, true);
    assert.equal(result.live, false);
    assert.equal(result.rooms, 1);
    assert.equal(result.wouldArchive, 100);
    assert.equal(result.archived, 0);
    assert.equal(result.roomId, null);
    assert.equal(projectionBytes(store, "big-a"), before);
    assert.equal(projectionMessageCount(store, "big-a"), 2100);
    assert.equal(store.room("big-a").state.messagesArchive, undefined, "no archive marker was written");
  });

  test("live tick archives exactly one room per tick, largest first", t => {
    const store = new RoomStore(":memory:");
    t.after(() => { store.close(); });
    seedRoom(store, "big-a", 2100, 420, "a");
    seedRoom(store, "big-b", 2050, 380, "b");
    const env = { ROOM_MESSAGES_ARCHIVE_LIVE: "1" };
    const first = runMessagesArchiveTick(store, { env });
    assert.equal(first.live, true);
    assert.equal(first.roomId, "big-a");
    assert.equal(first.archived, 100);
    assert.equal(projectionMessageCount(store, "big-a"), 2000);
    assert.ok(store.room("big-a").state.messagesArchive, "the archived room carries the marker");
    assert.equal(store.room("big-b").state.messagesArchive, undefined, "the second room waits for the next tick");
    const second = runMessagesArchiveTick(store, { env });
    assert.equal(second.roomId, "big-b");
    assert.equal(second.archived, 50);
    assert.equal(projectionMessageCount(store, "big-b"), 2000);
    const third = runMessagesArchiveTick(store, { env });
    assert.equal(third.archived, 0, "steady state: nothing left to move");
  });

  test("live tick skips a backfill-blocked room, records it, and archives the next due room", t => {
    const store = new RoomStore(":memory:");
    t.after(() => { store.close(); });
    // The largest room is poisoned the way the backfill suites poison a
    // room: a stored event whose messageId the current validator rejects,
    // with the projection rewritten to agree. The backfill parks it in
    // messages_backfill_blocks and certification can never complete.
    const events = [...initialRoom("big-blocked")];
    events.push(messageEvent("big-blocked", "ev-standin", "standin", "legacy text", 10));
    for (let i = 0; i < 2099; i++) {
      events.push(messageEvent("big-blocked", `blk-ev-${i}`, `blk-${i}`, `blk ${i} ` + "x".repeat(460), 100 + i));
    }
    events.push(messageEvent("big-blocked", "ev-tail", "tail", "after the poison", 3000));
    store.initialize(events);
    const row = store.db.prepare("SELECT sequence, body FROM events WHERE id='ev-standin'").get();
    const stored = JSON.parse(row.body);
    stored.data.messageId = "bad id@x";
    store.db.prepare("UPDATE events SET body=? WHERE id='ev-standin'").run(JSON.stringify(stored));
    const roomRow = store.db.prepare("SELECT projection FROM rooms WHERE id='big-blocked'").get();
    const projection = JSON.parse(roomRow.projection);
    projection.messages.find(message => message.id === "standin").id = "bad id@x";
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='big-blocked'").run(JSON.stringify(projection));
    seedRoom(store, "big-ok", 2050, 380, "ok");

    assert.ok(projectionBytes(store, "big-blocked") > projectionBytes(store, "big-ok"), "the blocked room is the largest");
    const blockedBefore = projectionMessageCount(store, "big-blocked");
    const result = runMessagesArchiveTick(store, { env: { ROOM_MESSAGES_ARCHIVE_LIVE: "1" } });
    assert.equal(result.roomId, "big-ok");
    assert.equal(result.archived, 50);
    const skip = result.reports.find(report => report.roomId === "big-blocked");
    assert.ok(skip, "the blocked room is on the tick's record");
    assert.equal(skip.ok, false);
    assert.equal(skip.detail, "backfill_blocked");
    assert.equal(projectionMessageCount(store, "big-blocked"), blockedBefore, "the blocked room was not touched");
    assert.equal(store.room("big-blocked").state.messagesArchive, undefined, "no marker on the blocked room");
    assert.ok(store.db.prepare("SELECT 1 FROM messages_backfill_blocks WHERE room_id='big-blocked'").get(),
      "the block is recorded in messages_backfill_blocks");
  });

  test("the registry run() returns the summary shape in dry-run posture", async t => {
    const store = new RoomStore(":memory:");
    t.after(() => { store.close(); });
    seedRoom(store, "big-a", 2100, 420, "a");
    const job = jobByName("messages-archive");
    const summary = await job.run(store, { env: {} });
    assert.deepEqual(Object.keys(summary).sort(), ["archived", "dryRun", "roomId", "rooms", "wouldArchive"]);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.rooms, 1);
    assert.equal(summary.wouldArchive, 100);
    assert.equal(summary.archived, 0);
    assert.equal(summary.roomId, null);
  });
});
