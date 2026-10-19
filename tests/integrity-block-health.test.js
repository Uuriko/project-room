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

// CURE-INTEGRITY-SCAN contract: a parked room no longer fails the tick.
// The health reads as the success the scannable rooms earned, with the
// blocked set riding the summary as its own numbers — and the public
// surface still carries no block evidence (ids, event ids, error text).
function assertParkedHealthy(view, runtime) {
  assert.equal(view.consecutiveFailures, 0, "a parked room does not fail the tick");
  assert.equal(view.lastErrorCode, null);
  assert.equal(view.lastErrorSubcheck, null);
  assert.equal(view.lastErrorRecordClass, null);
  if (runtime === "worker") {
    assert.equal(view.status, "ok");
    assert.equal(view.lastSummary?.blockedRooms, 1, "the blocked set rides the summary as its own number");
  }
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
  test(`${runtime} health reports a parked room as blocked counts on passing ticks across full rotations and reopen, then clears after import`, async t => {
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
    let lastView = null;
    for (let i = 0; i < 24; i++) {
      if (i === 12) {
        fixture.reopen();
        scheduler = schedulerFor();
      }
      at += HOUR_MS;
      const view = await tick();
      assertParkedHealthy(view, runtime);
      lastView = view;
      positions.add(fixture.store.db.prepare("SELECT step FROM integrity_job_cursor WHERE singleton=1").get().step);
    }
    assert.equal(positions.size, 11, "the complete deferred rotation keeps advancing");
    if (runtime === "worker") {
      assert.equal(lastView.lastSummary.blockedFailures, 1, "the recorded park rides the summary by the end of the rotation");
    }
    const parity = fixture.store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='healthy'").get();
    assert.ok(parity.parity_at_seq > 0, "the healthy room reaches parity despite the standing block");
    fixture.repair();
    // The import deletes the park row itself, so the bridge count reads
    // zero from the first post-repair tick; the durable integrity_failures
    // record the batch wrote for the park clears when a later backfill
    // visit finds the room caught up — within one full rotation — and
    // the summary's blockedFailures follows it off the envelope.
    let recovered = null;
    for (let i = 0; i < 12 && !recovered; i++) {
      at += HOUR_MS;
      const view = await tick();
      const cleared = runtime === "worker"
        ? view.lastSummary?.blockedRooms === 0 && view.lastSummary?.blockedFailures === undefined
        : fixture.store.db.prepare("SELECT COUNT(*) AS n FROM messages_backfill_blocks").get().n === 0
          && fixture.store.integrityFailures().length === 0;
      if (cleared) recovered = view;
    }
    assert.ok(recovered, "the blocked numbers clear within a rotation after the import repair");
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

// Regression (live, 2026-10-17): #3855's count reached the health surface
// only when a tick SUCCEEDED. applyOutcomes dropped a failing tick's
// summary, so while agent_connections kept integrity failing, the surface
// kept serving the last success summary — recorded before #3855 shipped —
// which has no blockedRooms key at all (absent, not zero). These cases run
// the whole Worker reporting chain (integrity.run -> runCronJobs ->
// applyOutcomes -> jobHealthView) on failing scans, starting from a stored
// success record whose summary predates the count.
test("failing scan: the persisted health summary carries blockedRooms (count only, never room ids)", async t => {
  const store = syntheticStore(t);
  park(store);
  store.db.prepare("INSERT INTO messages_backfill_blocks (room_id, sequence, event_id, error) VALUES (?, 3, ?, ?)")
    .run("second-blocked-room", privateEvent, privateError);
  // The live failure shape: an isolated agent_connections failure returned
  // (not thrown), with the scan's ordinary counts alongside it.
  store.verifyRoomIntegrity = async () => ({
    matched: 1, skipped: 1, verified: 0, invitations: 50, checked: 2, swept: 1,
    failures: [{ step: "agent_connections", code: "connection_integrity_error", message: privateError }]
  });
  const at = Date.now();
  let stored = applyOutcomes({}, [{ job: "integrity", ok: true, at: at - HOUR_MS, summary: { matched: 1, skipped: 1, verified: 0, invitations: 50, checked: 2, swept: 1 } }]);
  const outcomes = await runCronJobs({ integrity: () => integrity.run(store, {}) }, { now: () => at, log() {} });
  stored = applyOutcomes(stored, outcomes);
  const view = jobHealthView(stored, at).jobs.find(job => job.name === "integrity");
  assert.equal(view.status, "failing");
  assert.equal(view.lastErrorSubcheck, "agent_connections");
  assert.equal(view.lastErrorCode, "connection_integrity_error");
  assert.equal(view.lastSummary.blockedRooms, 2, "the failing tick's standing count is persisted, not dropped");
  assert.equal(view.lastSummary.matched, 1);
  assert.equal(view.lastSummaryAt, new Date(at).toISOString());
  for (const value of [privateRoom, "second-blocked-room", privateEvent, privateError]) {
    assert.ok(!JSON.stringify(view).includes(value), "public health must not contain block evidence");
  }

  // Same failing scan with the park cleared: zero reads as zero — the key
  // is present, not absent.
  store.db.exec("DELETE FROM messages_backfill_blocks");
  const outcomes2 = await runCronJobs({ integrity: () => integrity.run(store, {}) }, { now: () => at + HOUR_MS, log() {} });
  stored = applyOutcomes(stored, outcomes2);
  const view2 = jobHealthView(stored, at + HOUR_MS).jobs.find(job => job.name === "integrity");
  assert.equal(view2.status, "failing");
  assert.equal(view2.lastSummary.blockedRooms, 0);
});

test("thrown scan failure: the persisted health summary still carries blockedRooms", async t => {
  const store = syntheticStore(t);
  park(store);
  store.verifyRoomIntegrity = async () => { throw Object.assign(new Error(privateError), { integritySubcheck: "agent_connections" }); };
  const at = Date.now();
  const outcomes = await runCronJobs({ integrity: () => integrity.run(store, {}) }, { now: () => at, log() {} });
  const stored = applyOutcomes({}, outcomes);
  const view = jobHealthView(stored, at).jobs.find(job => job.name === "integrity");
  assert.equal(view.consecutiveFailures, 1);
  assert.equal(view.lastErrorSubcheck, "agent_connections");
  assert.equal(view.lastSummary.blockedRooms, 1);
  assert.ok(!JSON.stringify(view).includes(privateRoom), "public health must not contain block evidence");
});
