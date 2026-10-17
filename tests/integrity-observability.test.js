// #3334: an integrity failure must be diagnosable from the health surface.
// Before this fix the integrity job converted every throw into { errors: 1 },
// the heartbeat rendered only "1 error(s) in tick", the displayed summary was
// the last SUCCESSFUL tick's (unlabelled), and lastDurationMs was recorded
// but never exposed — three different root causes (messages parity, help
// history, room lifecycle) produced a byte-identical external signature.
// These tests pin the failure detail surviving the whole reporting chain:
// store tag -> jobs classifier -> heartbeat record -> public view.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event } from "../src/events.js";
import { JOBS, classifyIntegrityError } from "../server/jobs.mjs";
import { ServiceError } from "../server/service-error.mjs";
import {
  applyOutcomes, jobHealthView, runCronJobs, sanitizeFailureDetail, summaryFailure
} from "../cloudflare/job-heartbeat.mjs";

const integrityJob = JOBS.find(job => job.name === "integrity");

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "room-integrity-observability-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { integrity: "deferred" });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return store;
}

const tickStore = store => store.verifyRoomIntegrity({ yieldBetween: async () => {} });

async function settle(t, rooms = ["alpha"]) {
  const store = openStore(t);
  for (const id of rooms) store.initialize(initialRoom(id));
  await tickStore(store); // full tick writes the snapshot
  await tickStore(store); // incremental tick
  return store;
}

async function heartbeatTick(stored, store, at) {
  const outcomes = await runCronJobs(
    { integrity: () => integrityJob.run(store, { deadline: Date.now() + 5000 }) },
    { now: () => at, log: () => {} }
  );
  return applyOutcomes(stored, outcomes);
}

const viewOf = stored => jobHealthView(stored, Date.now()).jobs.find(job => job.name === "integrity");

test("classifyIntegrityError names sub-check, code, class and record class", () => {
  const parity = classifyIntegrityError(new Error("messages parity failed for alpha: current record m1 differs"));
  assert.deepEqual(parity, { code: "messages_parity_failed", subcheck: "messages_parity", errorClass: "integrity_mismatch", recordClass: "message" });
  assert.ok(!JSON.stringify(parity).includes("alpha"), "record identifiers never reach the detail");

  const backfill = classifyIntegrityError(new Error("messages backfill stopped at 41 before room alpha reached sequence 9"));
  assert.equal(backfill.subcheck, "messages_backfill");
  assert.equal(backfill.recordClass, "message");

  // Typed service errors carry their stable code; the sub-check is derived.
  const orphan = classifyIntegrityError(new ServiceError(503, "invitation_integrity_error", "Invitation record requires operator reconciliation"));
  assert.equal(orphan.code, "invitation_integrity_error");
  assert.equal(orphan.subcheck, "invitation_audit");
  assert.equal(orphan.recordClass, "invitation");

  const link = classifyIntegrityError(new ServiceError(503, "link_integrity_error", "Share link journal mismatch"));
  assert.equal(link.subcheck, "share_links");
  assert.equal(link.code, "link_integrity_error");

  // A store tag wins over message patterns.
  const tagged = new Error("messages parity failed for alpha: anything");
  tagged.integritySubcheck = "room_lifecycle";
  assert.equal(classifyIntegrityError(tagged).subcheck, "room_lifecycle");
  assert.equal(classifyIntegrityError(tagged).recordClass, "room");

  const storage = classifyIntegrityError(new Error("database disk image is malformed"));
  assert.equal(storage.errorClass, "storage");
  assert.equal(storage.subcheck, "unknown");
  assert.equal(storage.code, "integrity_check_failed");

  // Untyped error codes (e.g. sqlite's) are never carried onto the surface.
  const sqlite = new Error("no such table: integrity_snapshot");
  sqlite.code = "ERR_SQLITE_ERROR";
  const classified = classifyIntegrityError(sqlite);
  assert.equal(classified.errorClass, "schema");
  assert.equal(classified.code, "integrity_check_failed");
});

test("sanitizeFailureDetail keeps only short token fields", () => {
  assert.deepEqual(
    sanitizeFailureDetail({ code: "messages_parity_failed", subcheck: "messages_parity", errorClass: "integrity_mismatch", recordClass: "message" }),
    { code: "messages_parity_failed", subcheck: "messages_parity", errorClass: "integrity_mismatch", recordClass: "message" }
  );
  assert.deepEqual(sanitizeFailureDetail({ subcheck: "messages parity for room alpha" }), null);
  assert.deepEqual(sanitizeFailureDetail({ code: "x".repeat(200) }), null);
  assert.equal(sanitizeFailureDetail(null), null);
  assert.equal(sanitizeFailureDetail("messages_parity"), null);
});

test("the integrity job result no longer collapses to a bare error count", async t => {
  const store = await settle(t);
  store.db.prepare("UPDATE rooms SET archived_at='2026-10-01T00:00:00.000Z' WHERE id='alpha'").run();
  // Rotate the deferred batch until the lifecycle step throws.
  let result = null;
  for (let i = 0; i < 12 && !result; i++) {
    const run = await integrityJob.run(store, { deadline: Date.now() + 5000 });
    if (Number(run.errors) > 0) result = run;
  }
  assert.ok(result, "lifecycle poison eventually fails a tick");
  assert.equal(result.failureDetail.subcheck, "room_lifecycle");
  assert.equal(result.failureDetail.recordClass, "room");
  assert.match(summaryFailure(result), /room_lifecycle/);
  assert.doesNotMatch(summaryFailure(result), /^1 error\(s\) in tick$/);
});

test("deferred batch tags the throwing step on the error itself", async t => {
  const store = await settle(t);
  store.db.prepare("UPDATE rooms SET archived_at='2026-10-01T00:00:00.000Z' WHERE id='alpha'").run();
  let thrown = null;
  for (let i = 0; i < 12 && !thrown; i++) {
    try { await tickStore(store); } catch (error) { thrown = error; }
  }
  assert.ok(thrown, "lifecycle poison throws");
  assert.equal(thrown.integritySubcheck, "room_lifecycle");
});

test("full-path help-history failure is tagged help_history", async t => {
  const store = await settle(t);
  const row = store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get();
  const projection = JSON.parse(row.projection);
  projection.helpOffers = { poison: true };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(JSON.stringify(projection));
  const run = await integrityJob.run(store, { deadline: Date.now() + 5000 });
  assert.equal(run.failureDetail?.subcheck, "help_history");
  assert.equal(run.failureDetail?.recordClass, "invitation");
});

test("end to end: parity poison is named on the health surface, stale summary is labelled, recovery clears the detail", async t => {
  const store = await settle(t);
  const key = store.issueAccessKey("alpha", "owner");
  store.command(key, "alpha", { id: "m1", type: "message.posted", data: { body: "hello" } });
  let certified = false;
  for (let i = 0; i < 40 && !certified; i++) {
    await tickStore(store);
    certified = store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='alpha'").get()?.parity_at_seq != null;
  }
  assert.ok(certified, "parity certifies before the poison");

  const t0 = Date.now();
  let stored = await heartbeatTick({}, store, t0);
  const healthy = viewOf(stored);
  assert.equal(healthy.consecutiveFailures, 0);
  assert.equal(healthy.lastSummaryAt, new Date(t0).toISOString());
  const successSummary = healthy.lastSummary;
  assert.ok(successSummary && successSummary.matched === 1);

  // Poison: the messages table drifts from the projection.
  store.db.prepare("UPDATE messages SET body='tampered' WHERE room_id='alpha'").run();
  let failing = null;
  let lastHealthy = healthy;
  for (let i = 1; i <= 15 && !failing; i++) {
    stored = await heartbeatTick(stored, store, t0 + i * 3_600_000);
    const view = viewOf(stored);
    if (view.consecutiveFailures > 0) failing = view;
    else lastHealthy = view;
  }
  assert.ok(failing, "poisoned parity fails a tick");
  assert.match(failing.lastError, /messages_parity/);
  assert.equal(failing.lastErrorSubcheck, "messages_parity");
  assert.equal(failing.lastErrorCode, "messages_parity_failed");
  assert.equal(failing.lastErrorClass, "integrity_mismatch");
  assert.equal(failing.lastErrorRecordClass, "message");
  assert.equal(typeof failing.lastDurationMs, "number");
  assert.ok(!failing.lastError.includes("alpha"), "the room id never reaches the public error");
  // The summary is still the last healthy tick's — and lastSummaryAt says
  // exactly which tick produced it, so the staleness is visible, not silent.
  assert.deepEqual(failing.lastSummary, lastHealthy.lastSummary);
  assert.equal(failing.lastSummaryAt, lastHealthy.lastSummaryAt);
  assert.ok(successSummary);

  // Repair the drift (restore the authoritative body) and the job recovers:
  // the failure detail clears and the summary timestamp advances.
  store.db.prepare("UPDATE messages SET body='hello' WHERE room_id='alpha'").run();
  let recovered = null;
  for (let i = 16; i <= 40 && !recovered; i++) {
    stored = await heartbeatTick(stored, store, t0 + i * 3_600_000);
    const view = viewOf(stored);
    if (view.consecutiveFailures === 0) recovered = view;
  }
  assert.ok(recovered, "repaired parity recovers");
  assert.equal(recovered.lastErrorCode, null);
  assert.equal(recovered.lastErrorSubcheck, null);
  assert.notEqual(recovered.lastSummaryAt, new Date(t0).toISOString());
});

// Bug sweep F-3: a room parked in messages_backfill_blocks surfaced once
// as a named failure, then vanished — compactSummary dropped the batch
// result's blocked list, so steady-state ticks read ok while the room
// never backfilled or parity-certified. The park must keep the integrity
// job failing, with the count in the summary and the room named in the
// view, for exactly as long as the block exists.
test("end to end: a parked room keeps integrity failing by name until it is repaired", async t => {
  const store = openStore(t);
  const at = offset => new Date(Date.UTC(2026, 9, 2) + offset * 1000).toISOString();
  const messageEvent = (roomId, id, data, offset) => event({
    type: T.MESSAGE_POSTED, actorId: "owner", roomId, id, idempotencyKey: `${id}-key`, at: at(offset), data
  });
  // A legacy-shaped room: log and projection agree, but the stored event
  // carries a messageId the current reducer rejects (the #3847 poison).
  store.initialize([
    ...initialRoom("alpha"),
    messageEvent("alpha", "ev-standin", { messageId: "standin", body: "legacy text" }, 10),
    messageEvent("alpha", "ev-tail", { messageId: "tail", body: "after the poison" }, 11)
  ]);
  const row = store.db.prepare("SELECT body FROM events WHERE id='ev-standin'").get();
  const stored = JSON.parse(row.body);
  stored.data.messageId = "bad id@x";
  store.db.prepare("UPDATE events SET body=? WHERE id='ev-standin'").run(JSON.stringify(stored));
  const roomRow = store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get();
  const projection = JSON.parse(roomRow.projection);
  projection.messages.find(message => message.id === "standin").id = "bad id@x";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(JSON.stringify(projection));

  const t0 = Date.now();
  let storedHealth = {};
  // Rotate ticks until the deferred batch parks the room; the park tick
  // itself already names it (the job reads the durable table directly).
  let parked = null;
  for (let i = 1; i <= 20 && !parked; i++) {
    storedHealth = await heartbeatTick(storedHealth, store, t0 + i * 3_600_000);
    const view = viewOf(storedHealth);
    if (view.blockedRoomIds.includes("alpha")) parked = view;
  }
  assert.ok(parked, "the park reaches the health view");
  assert.equal(parked.status, "failing");
  assert.match(parked.lastError, /messages_backfill/, "the park tick names the sub-check");
  assert.deepEqual(parked.blockedRoomIds, ["alpha"]);

  // Steady state: the batch has advanced past the park and no fresh block
  // throws — the ticks that read ok before the fix must keep failing.
  for (let i = 21; i <= 23; i++) {
    storedHealth = await heartbeatTick(storedHealth, store, t0 + i * 3_600_000);
    const view = viewOf(storedHealth);
    assert.equal(view.status, "failing", `steady-state tick ${i} still fails`);
    assert.equal(view.lastError, "1 room(s) parked in messages backfill");
    assert.deepEqual(view.blockedRoomIds, ["alpha"]);
  }

  // Repair the stored log and move the room's head, so the backfill's
  // stale-block refresh re-diagnoses the room, clears the block, and the
  // room rejoins the sweep.
  const fixed = JSON.parse(row.body);
  store.db.prepare("UPDATE events SET body=? WHERE id='ev-standin'").run(JSON.stringify(fixed));
  const fixedProjection = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get().projection);
  fixedProjection.messages.find(message => message.id === "bad id@x").id = "standin";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(JSON.stringify(fixedProjection));
  const key = store.issueAccessKey("alpha", "owner");
  store.command(key, "alpha", { id: "m-after-repair", type: "message.posted", data: { body: "after repair" } });

  let recovered = null;
  for (let i = 24; i <= 48 && !recovered; i++) {
    storedHealth = await heartbeatTick(storedHealth, store, t0 + i * 3_600_000);
    const view = viewOf(storedHealth);
    if (view.status === "ok" && view.blockedRoomIds.length === 0) recovered = view;
  }
  assert.ok(recovered, "the repaired room's block clears and health recovers");
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.lastSummary.blockedRooms, 0);
  assert.deepEqual(recovered.blockedRoomIds, []);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages_backfill_blocks").get().n, 0);
});
