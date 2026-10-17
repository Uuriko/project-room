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

test("deferred batch isolates a throwing step: reported, recorded durably, cursor advances past it", async t => {
  const store = await settle(t);
  store.db.prepare("UPDATE rooms SET archived_at='2026-10-01T00:00:00.000Z' WHERE id='alpha'").run();
  let reported = null;
  for (let i = 0; i < 12 && !reported; i++) {
    const result = await tickStore(store);
    reported = result.failures.find(failure => failure.step === "room_lifecycle") ?? null;
  }
  assert.ok(reported, "lifecycle poison is reported as an isolated failure, not a throw");
  assert.equal(reported.recordId, "");
  const row = store.db.prepare("SELECT failures FROM integrity_failures WHERE step='room_lifecycle'").get();
  assert.ok(row && row.failures >= 1, "the failure is recorded durably");
  // The cursor is not frozen on the poisoned pair: the next tick rotates on.
  const before = store.db.prepare("SELECT step FROM integrity_job_cursor WHERE singleton=1").get().step;
  await tickStore(store);
  const after = store.db.prepare("SELECT step FROM integrity_job_cursor WHERE singleton=1").get().step;
  assert.notEqual(after, before, "the deferred cursor keeps advancing");
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
