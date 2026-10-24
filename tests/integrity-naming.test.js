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
//
// CURE-INTEGRITY-SCAN amendment: a room PARKED by the backfill (the
// wedged-room case below) no longer fails the tick, so it no longer
// shapes a failure detail — its name lives where the full outstanding
// list always lived, the token-gated operator status, and its presence
// rides the public summary as counts (blockedRooms / blockedFailures /
// blockedSince). Rooms that were scanned and FAILED (messages_parity,
// help_history) keep the failure-detail naming exactly as before.
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

test("wedged room: the parked room is named on the operator status; the public health view carries counts and stays id-free", async t => {
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

  // The job's verdict is now the scannable rooms': the park does not fail
  // the tick or shape a failure detail. The blocked set rides as its own
  // numbers, and gamma — no longer certified at its moved head — is not
  // counted among the verified rooms.
  const run = await integrityJob.run(store, { deadline: Date.now() + 5000 });
  assert.equal(run.errors, undefined);
  assert.equal(run.failureDetail, undefined);
  assert.equal(run.blockedFailures, 1);
  assert.equal(run.blockedRooms, 1);
  assert.equal(run.verifiedRooms, 1, "alpha remains verified; the parked room is not laundered into the count");

  // The heartbeat chain behind GET /api/health/jobs is public: the tick
  // reads as the success it is, the summary carries the blocked set as
  // counts, and the room's id never appears — a private room's id is
  // block evidence (integrity-block-health on main). The name lives on
  // the operator status (below).
  const outcomes = await runCronJobs(
    { integrity: () => integrityJob.run(store, { deadline: Date.now() + 5000 }) },
    { now: () => Date.now(), log: () => {} }
  );
  const view = jobHealthView(applyOutcomes({}, outcomes), Date.now()).jobs.find(job => job.name === "integrity");
  assert.equal(view.status, "ok");
  assert.equal(view.consecutiveFailures, 0);
  assert.equal(view.lastErrorCode, null);
  assert.equal(view.lastSummary.blockedRooms, 1);
  assert.equal(view.lastSummary.blockedFailures, 1);
  assert.equal(view.lastErrorRecordId, undefined, "the public health view carries no record id");
  assert.ok(!JSON.stringify(view).includes("gamma"), "the public health view contains no block evidence");

  // The token-gated operator status carries the full outstanding list,
  // the parked room named — the diagnosis surface the name was for.
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
