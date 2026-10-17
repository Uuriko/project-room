import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event } from "../src/events.js";
import { MESSAGES_BACKFILL_BLOCKS_SCHEMA } from "../server/messages-store.mjs";
import { JOBS, HOUR_MS, startNodeScheduler } from "../server/jobs.mjs";
import { runCronJobs, applyOutcomes, jobHealthView } from "../cloudflare/job-heartbeat.mjs";

const integrity = JOBS.find(job => job.name === "integrity");
const privateRoom = "private-blocked-room";
const privateEvent = "private-blocked-event";
const privateError = "private body details";

function assertPublicFailure(view) {
  assert.equal(view.lastErrorCode, "messages_backfill_failed");
  assert.equal(view.lastErrorSubcheck, "messages_backfill");
  assert.equal(view.lastErrorRecordClass, "message");
  assert.ok(view.consecutiveFailures > 0);
  for (const value of [privateRoom, privateEvent, privateError]) {
    assert.ok(!JSON.stringify(view).includes(value), "public health must not contain block evidence");
  }
}

// Poison diagnosis/parking itself is owned by messages-backfill-blocks.test.js.
// This fixture starts with its durable output, then tests the reporting owner
// through real integrity rotations, reopen, and the existing import repair path.
function openParkedFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-integrity-block-health-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename, { integrity: "deferred" });
  store.initialize(initialRoom(privateRoom));
  store.initialize([
    ...initialRoom("healthy"),
    event({ id: "healthy-event", roomId: "healthy", actorId: "owner", type: "message.posted",
      idempotencyKey: "healthy-message-key", at: "2026-10-02T00:00:10.000Z",
      data: { messageId: "healthy-message", body: "healthy message" } })
  ]);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get store() { return store; },
    park() {
      const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(privateRoom).sequence;
      store.db.prepare(`INSERT INTO messages_backfill_blocks (room_id, sequence, event_id, error, head_seq, blocked_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(privateRoom, head, privateEvent, privateError, head, Date.now());
    },
    reopen() { store.close(); store = new RoomStore(filename, { integrity: "deferred" }); },
    repair() {
      const key = store.issueAccessKey(privateRoom, "owner");
      const lines = store.db.prepare("SELECT sequence, body FROM events WHERE room_id=? ORDER BY sequence").all(privateRoom)
        .map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
      store.importEvents(key, privateRoom, lines);
    }
  };
}

for (const runtime of ["worker", "node"]) {
  test(`${runtime} health retains parked failures across full rotations and reopen, then clears after import`, async t => {
    const fixture = openParkedFixture(t);
    let at = Date.now();
    let stored = {};
    const schedulerFor = () => startNodeScheduler({ store: fixture.store, env: { GROWTH_WATCH_INTERVAL_MS: "0" }, tickMs: 0, now: () => at });
    let scheduler = schedulerFor();
    async function tick() {
      if (runtime === "node") {
        await scheduler.runOnce();
        return scheduler.jobHealth().find(job => job.name === "integrity");
      }
      const outcomes = await runCronJobs({ integrity: () => integrity.run(fixture.store, {
        room: { verifyRoomIntegrity: () => fixture.store.verifyRoomIntegrity({ deadline: Date.now() + 5000 }) }
      }) }, { now: () => at, log() {} });
      stored = applyOutcomes(stored, outcomes);
      return jobHealthView(stored, at).jobs.find(job => job.name === "integrity");
    }
    const healthy = await tick();
    assert.equal(healthy.consecutiveFailures, 0);
    fixture.park();
    const positions = new Set();
    for (let i = 0; i < 24; i++) {
      if (i === 12) {
        fixture.reopen();
        scheduler = schedulerFor();
      }
      at += HOUR_MS;
      const view = await tick();
      assertPublicFailure(view);
      if (runtime === "worker") assert.notEqual(view.status, "ok");
      positions.add(fixture.store.db.prepare("SELECT step FROM integrity_job_cursor WHERE singleton=1").get().step);
    }
    assert.equal(positions.size, 11, "the complete deferred rotation keeps advancing");
    const parity = fixture.store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='healthy'").get();
    assert.ok(parity.parity_at_seq > 0, "the healthy room reaches parity despite the standing block");
    fixture.repair();
    // Composed with the deferred-batch isolation on main (#3544): the
    // batch records the park as a durable integrity_failures row, which
    // targeted re-verification clears on a later rotation tick — so
    // recovery lands within one full rotation of the repair rather than
    // necessarily on the first tick after it. The bridge's own count
    // already reads zero from the first post-repair tick; the recorded
    // primary failure is preserved until re-verification clears it.
    let recovered = null;
    for (let i = 0; i < 12 && !recovered; i++) {
      at += HOUR_MS;
      const view = await tick();
      if (view.consecutiveFailures === 0) recovered = view;
    }
    assert.ok(recovered, "health recovers within a rotation after the import repair");
    assert.equal(recovered.lastErrorCode, null);
    assert.equal(recovered.lastSuccessAt, new Date(at).toISOString());
    if (runtime === "worker") assert.equal(recovered.status, "ok");
  });
}

function syntheticStore(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(MESSAGES_BACKFILL_BLOCKS_SCHEMA);
  t.after(() => db.close());
  return { db, verifyRoomIntegrity: async () => ({ budgetExceeded: 1, checked: 0 }) };
}

function park(store) {
  store.db.prepare("INSERT INTO messages_backfill_blocks (room_id, sequence, event_id, error) VALUES (?, 7, ?, ?)")
    .run(privateRoom, privateEvent, privateError);
}

test("a budget exit still reads the durable count and only an empty set permits a healthy result", async t => {
  const store = syntheticStore(t);
  park(store);
  const blocked = await integrity.run(store, { deadline: 0 });
  assert.equal(blocked.budgetExceeded, 1);
  assert.equal(blocked.blockedRooms, 1);
  assert.equal(blocked.failureDetail.code, "messages_backfill_failed");
  store.db.exec("DELETE FROM messages_backfill_blocks");
  const clear = await integrity.run(store, { deadline: 0 });
  assert.equal(clear.budgetExceeded, 1);
  assert.equal(clear.blockedRooms, 0);
  assert.equal(clear.errors, undefined);
});

test("normal verification runs before the block count so newly created and cleared blocks appear immediately", async t => {
  const store = syntheticStore(t);
  store.verifyRoomIntegrity = async () => { park(store); return { verified: 1 }; };
  assert.equal((await integrity.run(store, {})).blockedRooms, 1);
  store.verifyRoomIntegrity = async () => { store.db.exec("DELETE FROM messages_backfill_blocks"); return { verified: 1 }; };
  const recovered = await integrity.run(store, {});
  assert.equal(recovered.blockedRooms, 0);
  assert.equal(recovered.errors, undefined);
});

test("existing reported failures remain primary while the standing block count is observed", async t => {
  const store = syntheticStore(t);
  park(store);
  for (const prior of [
    { errors: 4, scanError: "existing safe error", failureDetail: { code: "messages_parity_failed", subcheck: "messages_parity", recordClass: "message" } },
    { errors: 2 },
    { scanError: "existing safe scan error" }
  ]) {
    store.verifyRoomIntegrity = async () => prior;
    assert.deepEqual(await integrity.run(store, {}), { ...prior, blockedRooms: 1 });
  }
});

test("a thrown verification failure survives a second failure reading the count", async () => {
  let reads = 0;
  const store = {
    verifyRoomIntegrity: async () => { throw Object.assign(new Error(privateError), { integritySubcheck: "messages_parity" }); },
    db: { prepare() { reads++; throw new Error(`database I/O error: ${privateRoom}`); } }
  };
  const result = await integrity.run(store, {});
  assert.equal(reads, 1, "a failed verification still observes the durable set");
  assert.equal(result.failureDetail.code, "messages_parity_failed");
  assert.ok(!JSON.stringify(result).includes(privateError));
  assert.ok(!JSON.stringify(result).includes(privateRoom));
});

for (const [name, value, errorClass] of [
  ["schema error", new Error(`no such table: ${privateRoom}`), "schema"],
  ["storage error", new Error(`database I/O error: ${privateError}`), "storage"],
  ["missing row", undefined], ["null count", { n: null }], ["negative count", { n: -1 }],
  ["fractional count", { n: 0.1 }], ["infinite count", { n: Infinity }]
]) {
  test(`a durable ${name} cannot report recovery or expose raw evidence`, async () => {
    const store = {
      verifyRoomIntegrity: async () => ({ budgetExceeded: 1 }),
      db: { prepare() { return { get() { if (value instanceof Error) throw value; return value; } }; } }
    };
    const result = await integrity.run(store, {});
    assert.ok(result.errors > 0);
    assert.equal(result.blockedRooms, undefined, "unknown is not a zero count");
    assert.equal(result.failureDetail.code, "messages_backfill_failed");
    assert.equal(result.failureDetail.recordClass, "message");
    if (errorClass) assert.equal(result.failureDetail.errorClass, errorClass);
    assert.equal(result.budgetExceeded, 1);
    for (const privateText of [privateRoom, privateEvent, privateError]) assert.ok(!JSON.stringify(result).includes(privateText));
  });
}
