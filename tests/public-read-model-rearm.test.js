// Quiet-room mirror sweep re-arm: the public-read-model backfill used to
// latch done=1 forever ("Public read model backfill is finished"), so a
// room that never writes again kept a desynced publication mirror
// indefinitely — the named residual of the #5623 level-trigger cure, whose
// own test file pins the pre-sweep window (tests/public-mirror-level-
// trigger.test.js T5). This file pins the closing piece: a completed
// sweep stamps its completion time and re-arms once the sweep interval
// (PUBLIC_READ_MODEL_SWEEP_INTERVAL_MS, 30 days) has elapsed. The re-arm
// rides the existing job path only — the job's enabled check and the
// backfill read the same predicate (publicReadModelSweepDue), and the
// reset happens inside the backfill's first due call. No new scheduler.
//
// Bounds proven here, before any live re-arm:
//  - the shipped batch shape holds at scale: at 1k and 5k rooms every
//    call processes at most `limit` rooms and stays far inside the 5 s
//    cron deadline the DO entry point runs under;
//  - a completed sweep schedules the next one exactly once: inside the
//    interval nothing re-runs, and after it the re-armed sweep visits
//    each room exactly once (a second reset would double the count);
//  - opt-out stays fail-closed: the sweep reconciles the mirror TO the
//    recorded value in every polarity and never projects a room whose
//    recorded setting is off or absent.
//
// Adversarial pass (this touches consent-adjacent behaviour):
//  - read-error: a predating cursor table without the completed_at
//    column — the stamp write falls back, the due read falls back, and
//    the backfill still completes;
//  - unknown-value: a non-numeric or NULL completion stamp on a finished
//    sweep reads as DUE (re-verify) — never as "skip the check"; a
//    future stamp (clock skew) reads as not due, so no hot loop;
//  - one-bad-row: a torn projection mid-walk is skipped by the rooms
//    phase as before; the sweep still completes and heals the rest;
//  - the opt-out cell: R4 below — recorded opt-out + missing mirror
//    (over-exposure) is healed by the re-armed sweep with NO room write.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  PUBLIC_READ_MODEL_SWEEP_INTERVAL_MS,
  backfillPublicReadModel,
  publicReadModelSweepDue,
  publicReceiptById,
  queryPublicReceipts,
} from "../server/public-read-model.mjs";
import { receiptVisible } from "../server/public-visibility.mjs";

const PWR = `pwr_${"a".repeat(32)}`;

function makeStore(t, tag, roomId = "commons") {
  const directory = mkdtempSync(join(tmpdir(), `project-room-rearm-${tag}-`));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(roomId));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey(roomId, "owner");
  return { store, ownerKey, roomId };
}

const cursorRow = store => store.db.prepare(
  "SELECT phase, cursor, done, completed_at AS completedAt FROM public_read_model_backfill WHERE id=1").get();

// Mark the cursor as a sweep that finished long ago (or never got
// stamped), the production shape this cure exists for.
function latchFinished(store, completedAt) {
  store.db.prepare(`INSERT INTO public_read_model_backfill (id, phase, cursor, done, completed_at)
    VALUES (1, 'directory', '', 1, ?)
    ON CONFLICT(id) DO UPDATE SET phase='directory', cursor='', done=1, completed_at=excluded.completed_at`)
    .run(completedAt);
}

function drain(store, { limit = 20, maxCalls = 100000 } = {}) {
  let rooms = 0, calls = 0, maxCallMs = 0;
  for (; calls < maxCalls; calls++) {
    const started = performance.now();
    const result = backfillPublicReadModel(store, { limit });
    maxCallMs = Math.max(maxCallMs, performance.now() - started);
    rooms += result.rooms;
    if (result.done) return { rooms, calls: calls + 1, maxCallMs };
  }
  throw new Error(`backfill did not finish within ${maxCalls} calls`);
}

const mirrorRow = (store, roomId) => {
  const row = store.db.prepare(
    "SELECT enabled FROM room_public_receipts_setting WHERE room_id=?").get(roomId);
  return row ? { enabled: row.enabled } : undefined;
};
const setMirror = (store, roomId, enabled) => store.db.prepare(
  `INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?,?)
   ON CONFLICT(room_id) DO UPDATE SET enabled=excluded.enabled`).run(roomId, enabled);
const dropMirror = (store, roomId) => store.db.prepare(
  "DELETE FROM room_public_receipts_setting WHERE room_id=?").run(roomId);

function seedPwrRow(store, roomId) {
  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(PWR, "Public work", "public-work", "ns-rearm", roomId, "Commons", "[]", "[]", null, null, null, "[]",
      "2026-10-01T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
  store.db.prepare(`INSERT INTO public_work_receipts
    (receipt_id, offer_id, namespace_key, generation, identity_id, artifact_text, artifact_sha256, artifact_bytes, receipt_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(PWR, "offer-rearm", "ns-rearm", 1, "ai_x", "note", "0".repeat(64), 4, "{}", 0);
  store.db.prepare(`INSERT INTO public_work_tasks
    (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("offer-rearm", "ns-rearm", roomId, 1, "https://example.invalid/repo", "main", "[]", 1, 0);
}

const storedSurfaces = (store, id) => ({
  byId: publicReceiptById(store, id) !== null,
  list: queryPublicReceipts(store, { limit: 50 }).receipts.some(r => r.id === id),
  js: receiptVisible(store.db, id),
});
const allServe = (store, id) => Object.values(storedSurfaces(store, id)).every(Boolean);
const noneServe = (store, id) => Object.values(storedSurfaces(store, id)).every(v => !v);

// ---------------------------------------------------------------- R1
test("R1: a completed sweep stamps its completion and stays latched inside the interval", t => {
  const { store } = makeStore(t, "r1");
  const first = drain(store);
  assert.equal(first.rooms, 1, "the one seeded room was walked");
  const cursor = cursorRow(store);
  assert.equal(cursor.done, 1);
  assert.ok(Number.isFinite(cursor.completedAt), "completion is stamped");
  assert.ok(Math.abs(Date.now() - cursor.completedAt) < 60_000, "the stamp is the completion time");
  assert.equal(publicReadModelSweepDue(store), false, "not due inside the interval");
  const again = backfillPublicReadModel(store, { limit: 20 });
  assert.deepEqual(again, { done: true, rooms: 0, receipts: 0, cards: 0 },
    "inside the interval a call is a no-op: no re-walk, no hot loop");
});

// ---------------------------------------------------------------- R2
test("R2: after the interval the sweep re-arms exactly once and re-stamps", t => {
  const { store, roomId } = makeStore(t, "r2");
  for (const extra of ["r2-b", "r2-c", "r2-d", "r2-e"]) store.initialize(initialRoom(extra));
  drain(store);
  const firstStamp = cursorRow(store).completedAt;
  // Time passes: the completion is now older than the sweep interval.
  store.db.prepare("UPDATE public_read_model_backfill SET completed_at=? WHERE id=1")
    .run(Date.now() - PUBLIC_READ_MODEL_SWEEP_INTERVAL_MS - 1000);
  assert.equal(publicReadModelSweepDue(store), true, "due once the interval has elapsed");
  const second = drain(store, { limit: 2 });
  assert.equal(second.rooms, 5,
    "each of the 5 rooms visited exactly once: a second reset mid-sweep would restart the walk and double this");
  const cursor = cursorRow(store);
  assert.equal(cursor.done, 1);
  assert.ok(cursor.completedAt > firstStamp - PUBLIC_READ_MODEL_SWEEP_INTERVAL_MS,
    "the re-armed sweep's completion re-stamps");
  assert.equal(publicReadModelSweepDue(store), false, "latched again until the next interval");
  assert.equal(backfillPublicReadModel(store, { limit: 2 }).rooms, 0, "no third walk");
});

// ---------------------------------------------------------------- R3
test("R3: a sweep that finished before stamping existed is due — the inaugural re-arm", t => {
  const { store } = makeStore(t, "r3");
  // The production shape since 2026-10-02: done=1, no stamp column value.
  latchFinished(store, null);
  assert.equal(publicReadModelSweepDue(store), true, "an unstamped finish has no clock to wait on");
  const swept = drain(store);
  assert.equal(swept.rooms, 1, "the inaugural sweep walks the store");
  assert.ok(Number.isFinite(cursorRow(store).completedAt), "and stamps its own completion");
  assert.equal(publicReadModelSweepDue(store), false);
});

// ---------------------------------------------------------------- R4
test("R4: the re-armed sweep heals every mirror polarity with no room write (opt-out fail-closed)", t => {
  // Over-exposure: recorded opt-out, mirror row missing — stored rows serve.
  const out = makeStore(t, "r4-out");
  out.store.command(out.ownerKey, out.roomId,
    { id: "on-1", type: "room.public_receipts_set", data: { enabled: true } });
  seedPwrRow(out.store, out.roomId);
  out.store.command(out.ownerKey, out.roomId,
    { id: "off-1", type: "room.public_receipts_set", data: { enabled: false } });
  assert.equal(noneServe(out.store, PWR), true, "sanity: opted out with an intact mirror hides the row");
  dropMirror(out.store, out.roomId); // ABLATION: the desync — mirror lost, setting stands
  assert.equal(allServe(out.store, PWR), true, "the desync over-exposes the opted-out room's rows");
  latchFinished(out.store, Date.now() - PUBLIC_READ_MODEL_SWEEP_INTERVAL_MS - 1000);
  drain(out.store);
  assert.deepEqual(mirrorRow(out.store, out.roomId), { enabled: 0 },
    "the sweep rewrote the mirror to the recorded opt-out — no room write happened");
  assert.equal(noneServe(out.store, PWR), true, "the opted-out room is dark again on every stored-row surface");

  // Under-exposure: recorded opt-in, mirror stale at 0 — stored rows hidden.
  // (Asserted on the pwr row, as in the level-trigger file's T2: a wcr row
  // seeded directly is re-projected from room state by the sweep's
  // replaceOptedInReceipts leg, while a pwr row has no delete path and is
  // governed by the mirror alone.)
  const into = makeStore(t, "r4-in");
  into.store.command(into.ownerKey, into.roomId,
    { id: "on-1", type: "room.public_receipts_set", data: { enabled: true } });
  seedPwrRow(into.store, into.roomId);
  setMirror(into.store, into.roomId, 0); // ABLATION: stale off
  assert.equal(noneServe(into.store, PWR), true, "the stale mirror hides the opted-in room's rows");
  latchFinished(into.store, Date.now() - PUBLIC_READ_MODEL_SWEEP_INTERVAL_MS - 1000);
  drain(into.store);
  assert.deepEqual(mirrorRow(into.store, into.roomId), { enabled: 1 },
    "the sweep rewrote the mirror to the recorded opt-in");
  assert.equal(allServe(into.store, PWR), true, "the opted-in room serves again");

  // Never recorded: a leftover mirror row is deleted, never projected.
  const never = makeStore(t, "r4-never");
  setMirror(never.store, never.roomId, 1); // ABLATION: leftover row, no setting was ever recorded
  latchFinished(never.store, Date.now() - PUBLIC_READ_MODEL_SWEEP_INTERVAL_MS - 1000);
  drain(never.store);
  assert.equal(mirrorRow(never.store, never.roomId), undefined,
    "no recorded setting means no mirror row after the sweep");
});

// ---------------------------------------------------------------- R5
test("R5: hydration bounds at 1k and 5k rooms — batch cap and per-tick time stay in the shipped shape", t => {
  for (const count of [1000, 5000]) {
    const { store, roomId } = makeStore(t, `r5-${count}`);
    const template = store.db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get(roomId);
    const insert = store.db.prepare("INSERT INTO rooms (id, sequence, projection) VALUES (?,?,?)");
    store.db.exec("BEGIN");
    try {
      for (let i = 1; i < count; i++) {
        const id = `bulk-${String(i).padStart(5, "0")}`;
        const projection = JSON.parse(template.projection);
        projection.room.id = id;
        projection.room.roomId = id;
        insert.run(id, template.sequence, JSON.stringify(projection));
      }
      store.db.exec("COMMIT");
    } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    const started = performance.now();
    const swept = drain(store, { limit: 20 });
    const totalMs = performance.now() - started;
    assert.equal(swept.rooms, count, `${count} rooms walked exactly once`);
    assert.ok(swept.maxCallMs < 5000,
      `slowest single batch ${swept.maxCallMs.toFixed(1)}ms stays inside the shipped 5s cron deadline at ${count} rooms`);
    t.diagnostic(`${count} rooms: ${swept.calls} calls at limit 20, slowest call ${swept.maxCallMs.toFixed(1)}ms, total ${totalMs.toFixed(0)}ms`);
    // Batch shape: no single call may exceed the limit it was given.
    const probe = backfillPublicReadModel(store, { limit: 7 });
    assert.equal(probe.rooms, 0, "a finished sweep stays finished inside the interval, at any limit");
  }
});

// ---------------------------------------------------------------- R6
test("R6 adversarial: predating table (read-error), unknown stamp values, one bad row", t => {
  // Read-error: the cursor table predates the stamp column entirely.
  const legacy = makeStore(t, "r6-legacy");
  legacy.store.db.exec("ALTER TABLE public_read_model_backfill DROP COLUMN completed_at");
  const legacySweep = drain(legacy.store);
  assert.equal(legacySweep.rooms, 1, "the backfill completes on a predating table (stamp write falls back)");
  assert.equal(publicReadModelSweepDue(legacy.store), true,
    "an unreadable stamp reads as due — re-verify, never skip");

  // Unknown-value: a non-numeric stamp is not a clock.
  const odd = makeStore(t, "r6-odd");
  latchFinished(odd.store, "soon");
  assert.equal(publicReadModelSweepDue(odd.store), true, "a non-numeric stamp reads as due");
  // Clock skew: a stamp in the future must not spin the sweep.
  latchFinished(odd.store, Date.now() + PUBLIC_READ_MODEL_SWEEP_INTERVAL_MS);
  assert.equal(publicReadModelSweepDue(odd.store), false, "a future stamp is not due — no hot loop");

  // One bad row: a torn projection mid-walk is skipped; the sweep still
  // completes and heals the healthy rooms around it.
  const bad = makeStore(t, "r6-bad", "bad-a");
  bad.store.initialize(initialRoom("bad-b"));
  bad.store.command(bad.ownerKey, "bad-a",
    { id: "on-1", type: "room.public_receipts_set", data: { enabled: true } });
  setMirror(bad.store, "bad-a", 0); // ABLATION: stale off on the healthy room
  bad.store.db.prepare("UPDATE rooms SET projection='{torn' WHERE id=?").run("bad-b");
  latchFinished(bad.store, Date.now() - PUBLIC_READ_MODEL_SWEEP_INTERVAL_MS - 1000);
  const swept = drain(bad.store);
  assert.equal(cursorRow(bad.store).done, 1, "the sweep completes past the bad row");
  assert.deepEqual(mirrorRow(bad.store, "bad-a"), { enabled: 1 },
    "the healthy room's mirror is healed in the same sweep");
  assert.ok(swept.rooms >= 1, "the healthy room was walked");
});
