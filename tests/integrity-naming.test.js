// Integrity failure NAMING: batch isolation (#3544) records WHICH room is
// poisoned in integrity_failures, but the name reached only the console
// log line — the job's failure detail, the heartbeat behind
// GET /api/health/jobs, and the operator status all carried the sub-check
// and class without the room, so a wedged room could be diagnosed only
// from Worker dashboard logs. These tests pin the naming contract: for
// the steps whose records are rooms (messages_backfill, messages_parity,
// help_history), the failing room's id rides the failure detail through
// the whole reporting chain; every other record id (invitations above
// all) stays off the surface, and the public error string stays id-free.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { JOBS } from "../server/jobs.mjs";
import {
  applyOutcomes, jobHealthView, runCronJobs, sanitizeFailureDetail
} from "../cloudflare/job-heartbeat.mjs";
import { operatorStatus } from "../server/operator-status.mjs";

const integrityJob = JOBS.find(job => job.name === "integrity");
const tick = store => store.verifyRoomIntegrity({ yieldBetween: async () => {} });

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "room-integrity-naming-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { integrity: "deferred" });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return store;
}

async function settle(t, rooms) {
  const store = openStore(t);
  for (const id of rooms) store.initialize(initialRoom(id));
  await tick(store); // full tick writes the snapshot
  await tick(store); // incremental tick
  return store;
}

function post(store, roomId, id, body) {
  const key = store.issueAccessKey(roomId, "owner");
  return store.command(key, roomId, { id, type: "message.posted", data: { body } }).event.id;
}

async function certify(store, roomId) {
  for (let i = 0; i < 40; i++) {
    await tick(store);
    const row = store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
    if (row?.parity_at_seq != null && row.parity_at_seq === store.room(roomId).sequence) return true;
  }
  return false;
}

test("wedged room: the poisoned room is named on the job detail, the health view, and operator status", async t => {
  const store = await settle(t, ["alpha", "gamma"]);
  post(store, "gamma", "g1", "first");
  post(store, "gamma", "g2", "second");
  assert.ok(await certify(store, "gamma"), "gamma certifies before the poison");
  assert.ok(await certify(store, "alpha"), "alpha certifies before the poison");

  // Poison (the production shape): gamma's stored sequence runs ahead of
  // its event log, so the log can never replay to the room's sequence.
  store.db.prepare("UPDATE rooms SET sequence = sequence + 3 WHERE id='gamma'").run();

  let recorded = null;
  for (let i = 0; i < 14 && !recorded; i++) {
    const result = await tick(store);
    if (result.failures?.some(f => f.step === "messages_backfill" && f.recordId === "gamma")) recorded = result;
  }
  assert.ok(recorded, "the backfill step records gamma's failure");

  // The job's own output names the room in its failure detail, while the
  // public error string stays id-free (the #3544 pin still holds).
  const run = await integrityJob.run(store, { deadline: Date.now() + 5000 });
  assert.ok(Number(run.errors) >= 1);
  assert.equal(run.failureDetail.subcheck, "messages_backfill");
  assert.equal(run.failureDetail.code, "messages_backfill_failed");
  assert.equal(run.failureDetail.recordId, "gamma", "the job detail names the poisoned room");
  assert.ok(!run.scanError.includes("gamma"), "the public error string carries no id");

  // The heartbeat chain behind GET /api/health/jobs keeps the name.
  const outcomes = await runCronJobs(
    { integrity: () => integrityJob.run(store, { deadline: Date.now() + 5000 }) },
    { now: () => Date.now(), log: () => {} }
  );
  const view = jobHealthView(applyOutcomes({}, outcomes), Date.now()).jobs.find(job => job.name === "integrity");
  assert.equal(view.lastErrorCode, "messages_backfill_failed");
  assert.equal(view.lastErrorSubcheck, "messages_backfill");
  assert.equal(view.lastErrorRecordId, "gamma", "the health view names the poisoned room");

  // The token-gated operator status carries the full outstanding list.
  const rows = operatorStatus(store).integrityFailures;
  assert.ok(
    rows.some(row => row.step === "messages_backfill" && row.recordId === "gamma"),
    "operator status lists gamma's outstanding failure"
  );
});

test("job detail: a room-record failure is the one named; non-room record ids are never attached", async () => {
  const stub = failures => ({ verifyRoomIntegrity: async () => ({ failures }) });

  const invitationOnly = await integrityJob.run(stub([
    {
      step: "invitation_audit", recordId: "inv-9f8e7d6c5b", code: "invitation_integrity_error",
      message: "Invitation record requires operator reconciliation"
    }
  ]), { deadline: Date.now() + 5000 });
  assert.equal(invitationOnly.failureDetail.subcheck, "invitation_audit");
  assert.equal(invitationOnly.failureDetail.recordId, undefined, "an invitation id never reaches the detail");
  assert.ok(!JSON.stringify(invitationOnly.failureDetail).includes("inv-9f8e7d6c5b"));

  const mixed = await integrityJob.run(stub([
    {
      step: "invitation_audit", recordId: "inv-9f8e7d6c5b", code: "invitation_integrity_error",
      message: "Invitation record requires operator reconciliation"
    },
    {
      step: "messages_parity", recordId: "room-z", code: "messages_parity_failed",
      message: "messages parity failed for room-z: projection count 2, table count 1, projection last seq 2, table last seq 1"
    }
  ]), { deadline: Date.now() + 5000 });
  assert.equal(mixed.failureDetail.subcheck, "messages_parity", "the room failure shapes the detail");
  assert.equal(mixed.failureDetail.recordId, "room-z", "the room is named even when another failure sorts first");
  assert.ok(!JSON.stringify(mixed.failureDetail).includes("inv-9f8e7d6c5b"));
});

test("sanitizer: an id-shaped recordId passes; anything else is dropped", () => {
  const clean = sanitizeFailureDetail({
    code: "messages_parity_failed", subcheck: "messages_parity",
    errorClass: "integrity_mismatch", recordClass: "message", recordId: "johns-project-room"
  });
  assert.equal(clean.recordId, "johns-project-room");
  const dirty = sanitizeFailureDetail({
    code: "messages_parity_failed", subcheck: "messages_parity",
    recordId: "room id with spaces and a body: hello world"
  });
  assert.equal(dirty.recordId, undefined, "a non-id recordId never rides the channel");
});
