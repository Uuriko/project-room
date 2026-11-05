// S3 (change-programme starter tranche, wave 2026-11-01-fifty): the
// recorded public-receipts setting's mirror
// (room_public_receipts_setting) is maintained LEVEL-triggered.
//
// The mirror is load-bearing for stored-row receipts: the
// recorded-opt-out leg reads it on every public read (public reads
// never touch rooms.projection — server/public-visibility.mjs), above
// all for public-work (pwr_) rows, which no delete path can remove.
// Before this cure, syncRoomPublication rewrote the mirror only on a
// recorded-revision edge (or a null previous). A mirror desynced at an
// unchanged revision was therefore IMMORTAL: ordinary room activity
// never corrected it, and it moved stored-row exposure in both
// directions, indefinitely — a stale enabled=0 hid an opted-in room's
// rows on every stored-row surface while its lots (which read the
// authoritative record) served, and a missing mirror row served an
// opted-out room's rows while its lots stayed private. Producers of a
// desynced mirror at an unchanged revision are real: a predating
// store whose room the one-shot backfill skipped (its per-room catch
// swallows a torn projection and the done flag is terminal), and the
// operator projection repair, which rewrites rooms.projection from
// the journal and nothing else.
//
// Failing-first: the probe form of this file (tests/s3-mirror-drift
// .test.js in the S3 lane record) ran at base ef583ba8 — P3a/P3b/P4
// asserted the drift persists after ordinary activity and PASSED
// (the drift was constructible); P1 asserted the command path's
// atomicity and passed (a mirror-write failure rolls the recorded
// event back with it — the partial-failure case is not constructible
// through commands, and this cure keeps that property: the mirror
// comparison and write stay inside the caller's transaction).
//
// What this cure does NOT claim: reconciliation is write-triggered.
// A room that never writes again keeps a desynced mirror until its
// next write (T5 pins the pre-write window honestly); a periodic
// bounded reconciliation sweep is a separate, jobs-side change.
//
// Seeding convention matches the repo's mirror tests: public rows are
// inserted directly; mirror writes labelled ABLATION are the desync
// injection, never datum seeding. Everything else goes through real
// entry points (RoomStore commands, backfillPublicReadModel).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  backfillPublicReadModel,
  publicReceiptById,
  queryPublicReceipts,
} from "../server/public-read-model.mjs";
import {
  lotReceiptVisible,
  receiptVisible,
  recordedReceiptsOptOut,
  recordedReceiptsSetting,
} from "../server/public-visibility.mjs";

const ROOM = "commons";
const WCR = `wcr_${"b".repeat(32)}`;
const PWR = `pwr_${"a".repeat(32)}`;
const LOT = `lot_${"c".repeat(16)}`;

function makeStore(t, tag) {
  const directory = mkdtempSync(join(tmpdir(), `project-room-s3lt-${tag}-`));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(ROOM));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  return { store, ownerKey };
}

const setSetting = (ctx, id, enabled) => ctx.store.command(ctx.ownerKey, ROOM,
  { id, type: "room.public_receipts_set", data: { enabled } });
const postMessage = (ctx, id) => ctx.store.command(ctx.ownerKey, ROOM,
  { id, type: "message.posted", data: { messageId: `m-${id}`, body: "ordinary activity" } });

const mirrorRow = (store) => {
  const row = store.db.prepare(
    "SELECT enabled FROM room_public_receipts_setting WHERE room_id=?").get(ROOM);
  return row ? { enabled: row.enabled } : undefined; // plain object: node:sqlite rows are null-prototype
};
const setMirror = (store, enabled) => store.db.prepare(
  `INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?,?)
   ON CONFLICT(room_id) DO UPDATE SET enabled=excluded.enabled`).run(ROOM, enabled);
const dropMirror = (store) => store.db.prepare(
  "DELETE FROM room_public_receipts_setting WHERE room_id=?").run(ROOM);

function seedWcrRow(store) {
  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(WCR, "Settled work", "work-claim", ROOM, ROOM, "Commons", "[]", "[]", null, null, null, "[]",
      "2026-10-01T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
}

function seedPwrRow(store) {
  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(PWR, "Public work", "public-work", "ns-s3", ROOM, "Commons", "[]", "[]", null, null, null, "[]",
      "2026-10-01T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
  store.db.prepare(`INSERT INTO public_work_receipts
    (receipt_id, offer_id, namespace_key, generation, identity_id, artifact_text, artifact_sha256, artifact_bytes, receipt_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(PWR, "offer-s3", "ns-s3", 1, "ai_x", "note", "0".repeat(64), 4, "{}", 0);
  store.db.prepare(`INSERT INTO public_work_tasks
    (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("offer-s3", "ns-s3", ROOM, 1, "https://example.invalid/repo", "main", "[]", 1, 0);
}

const storedSurfaces = (store, id) => ({
  byId: publicReceiptById(store, id) !== null,
  list: queryPublicReceipts(store, { limit: 50 }).receipts.some(r => r.id === id),
  js: receiptVisible(store.db, id),
});
const allServe = (store, id) => Object.values(storedSurfaces(store, id)).every(Boolean);
const noneServe = (store, id) => Object.values(storedSurfaces(store, id)).every(v => !v);

// ---------------------------------------------------------------- T1
test("T1: a mirror-write failure inside a receipts_set command rolls the whole command back", t => {
  const ctx = makeStore(t, "t1");
  setSetting(ctx, "on-1", true);
  assert.deepEqual(mirrorRow(ctx.store), { enabled: 1 }, "sanity: opt-in mirrored");
  ctx.store.db.exec(`CREATE TRIGGER s3lt_sabotage_ins BEFORE INSERT ON room_public_receipts_setting
    BEGIN SELECT RAISE(ABORT, 'level-trigger sabotage'); END`);
  ctx.store.db.exec(`CREATE TRIGGER s3lt_sabotage_upd BEFORE UPDATE ON room_public_receipts_setting
    BEGIN SELECT RAISE(ABORT, 'level-trigger sabotage'); END`);
  let threw = false;
  try { setSetting(ctx, "off-1", false); } catch { threw = true; }
  ctx.store.db.exec("DROP TRIGGER s3lt_sabotage_ins");
  ctx.store.db.exec("DROP TRIGGER s3lt_sabotage_upd");
  assert.equal(threw, true, "the sabotaged sync surfaces as a command failure");
  const state = ctx.store.room(ROOM).state;
  assert.equal(state.room.publicReceipts?.enabled, true, "the recorded setting did NOT move: the event rolled back with the sync");
  assert.equal(state.room.publicReceipts?.revision, 1, "revision unchanged after rollback");
  assert.deepEqual(mirrorRow(ctx.store), { enabled: 1 }, "mirror unchanged after rollback");
  setSetting(ctx, "off-2", false);
  assert.deepEqual(mirrorRow(ctx.store), { enabled: 0 }, "control: with the sabotage gone the same command lands and mirrors");
});

// ---------------------------------------------------------------- T2
test("T2: a mirror poisoned to 0 at an unchanged revision is healed by the room's next write", t => {
  const ctx = makeStore(t, "t2");
  setSetting(ctx, "on-1", true);
  seedWcrRow(ctx.store);
  seedPwrRow(ctx.store);
  assert.equal(allServe(ctx.store, PWR), true, "sanity: pwr serves while opted in");
  setMirror(ctx.store, 0); // ABLATION: the mirror claims OFF, the record says ON (revision untouched)
  assert.equal(noneServe(ctx.store, WCR), true, "pre-heal: the stale mirror hides the wcr row (reads still honour the mirror)");
  assert.equal(noneServe(ctx.store, PWR), true, "pre-heal: the stale mirror hides the pwr row");
  assert.equal(lotReceiptVisible(ctx.store.db, { id: LOT, roomId: ROOM }), true,
    "pre-heal: the lot surface follows the authoritative ON — the drift window is real");
  postMessage(ctx, "ordinary-1");
  assert.deepEqual(mirrorRow(ctx.store), { enabled: 1 }, "the next write reconciles the mirror to the recorded value");
  assert.equal(allServe(ctx.store, PWR), true, "the pwr row serves again — stored-row and lot surfaces agree");
  assert.equal(lotReceiptVisible(ctx.store.db, { id: LOT, roomId: ROOM }), true, "the lot still serves: full agreement");
});

// ---------------------------------------------------------------- T3
test("T3: a missing mirror row for an opted-out room is recreated by the room's next write", t => {
  const ctx = makeStore(t, "t3");
  setSetting(ctx, "on-1", true);
  setSetting(ctx, "off-1", false);
  seedPwrRow(ctx.store); // projected late (the backfill receipts phase shape): no delete path removes a pwr row
  seedWcrRow(ctx.store);
  assert.equal(noneServe(ctx.store, PWR), true, "sanity: the mirror leg hides the late pwr row");
  dropMirror(ctx.store); // ABLATION: the mirror row is lost, the record still says OFF
  assert.equal(allServe(ctx.store, PWR), true, "pre-heal: the pwr row serves — the opt-out leg has nothing to read");
  assert.equal(recordedReceiptsOptOut(ctx.store.db, ROOM), false, "pre-heal: the dedicated door's opt-out check also reads no opt-out");
  assert.equal(lotReceiptVisible(ctx.store.db, { id: LOT, roomId: ROOM }), false,
    "pre-heal: the lot surface follows the authoritative OFF — the drift window is real");
  postMessage(ctx, "ordinary-1");
  assert.deepEqual(mirrorRow(ctx.store), { enabled: 0 }, "the next write recreates the mirror row at the recorded value");
  assert.equal(noneServe(ctx.store, PWR), true, "the pwr row is hidden again");
  assert.equal(noneServe(ctx.store, WCR), true, "the wcr row is hidden again");
  assert.equal(recordedReceiptsOptOut(ctx.store.db, ROOM), true, "the door's opt-out check agrees again");
});

// ---------------------------------------------------------------- T4
test("T4: a stale mirror row on a room that never recorded a setting is deleted by its next write", t => {
  const ctx = makeStore(t, "t4");
  setMirror(ctx.store, 1); // ABLATION: a leftover row; the room never recorded a setting
  assert.deepEqual(mirrorRow(ctx.store), { enabled: 1 }, "sanity: the stale row is in place");
  postMessage(ctx, "ordinary-1");
  assert.equal(mirrorRow(ctx.store), undefined,
    "no recorded setting means no mirror row: the write deletes the leftover (never-recorded stays private, #3594)");
});

// ---------------------------------------------------------------- T5
test("T5: backfill skip + projection repair — the exposure persists until the room's next write, which heals it", t => {
  const ctx = makeStore(t, "t5");
  const { store } = ctx;
  setSetting(ctx, "on-1", true);
  seedPwrRow(store);
  setSetting(ctx, "off-1", false);
  assert.equal(noneServe(store, PWR), true, "sanity: opted out, mirror leg hides the pwr row");
  // Predating shape: the mirror row was never written for this room
  // (the setting and the rows predate the mirror), and the one-shot
  // backfill has not run yet.
  dropMirror(store);
  store.db.prepare(`INSERT INTO public_read_model_backfill (id, phase, cursor, done) VALUES (1, 'rooms', '', 0)
    ON CONFLICT(id) DO UPDATE SET phase='rooms', cursor='', done=0`).run();
  // The room's stored projection is torn when the backfill reaches it:
  // the rooms phase swallows the per-room failure and advances.
  const saved = store.db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get(ROOM);
  store.db.prepare("UPDATE rooms SET projection='{torn' WHERE id=?").run(ROOM);
  for (let i = 0; i < 10 && !backfillPublicReadModel(store, { limit: 20 }).done; i++) { /* drain */ }
  const cursor = store.db.prepare("SELECT done FROM public_read_model_backfill WHERE id=1").get();
  assert.equal(cursor.done, 1, "the backfill completed");
  assert.equal(mirrorRow(store), undefined, "the skipped room was never re-mirrored");
  // The operator repair line replaces rooms.projection from the journal
  // and nothing else (server/operator-projection-repair.mjs carries no
  // syncRoomPublication call). Its write, with the journal-true bytes:
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=? AND sequence=?")
    .run(saved.projection, ROOM, saved.sequence);
  assert.deepEqual(recordedReceiptsSetting(store.db, ROOM), { status: "recorded", enabled: 0 },
    "the repaired projection records the opt-out");
  assert.equal(backfillPublicReadModel(store, { limit: 20 }).done, true, "the backfill never re-runs: done is terminal");
  assert.equal(allServe(store, PWR), true,
    "RESIDUAL (pinned, not hidden): with no mirror and no write since the repair, the pwr row still serves");
  postMessage(ctx, "ordinary-1");
  assert.deepEqual(mirrorRow(store), { enabled: 0 }, "the room's next write recreates the mirror at the recorded value");
  assert.equal(noneServe(store, PWR), true, "the pwr row is hidden from that write on");
});

// ---------------------------------------------------------------- T6
test("T6: a corrupt mirror value (enabled=2) counts as a mismatch and is rewritten clean", t => {
  const ctx = makeStore(t, "t6");
  setSetting(ctx, "on-1", true);
  seedPwrRow(ctx.store);
  // ABLATION: a recorded row whose value no writer produces. The SQL
  // leg already treats it as an opt-out (enabled IS NOT 1); the
  // maintenance must not mistake it for a matching mirror.
  setMirror(ctx.store, 2);
  assert.equal(noneServe(ctx.store, PWR), true, "pre-heal: the corrupt value hides the row (fail-closed read, as designed)");
  postMessage(ctx, "ordinary-1");
  assert.deepEqual(mirrorRow(ctx.store), { enabled: 1 }, "the next write rewrites the corrupt value to the recorded 1");
  assert.equal(allServe(ctx.store, PWR), true, "the row serves on the clean mirror");
});

// ---------------------------------------------------------------- T7
test("T7: reconciliation is per-room — one room's poisoned mirror is untouched by another room's writes", t => {
  const ctx = makeStore(t, "t7");
  const { store, ownerKey } = ctx;
  setSetting(ctx, "on-1", true);
  setMirror(store, 0); // ABLATION on ROOM
  // A second room in the same store, opted in, mirror correct.
  store.initialize(initialRoom("annex"));
  const annexKey = store.issueAccessKey("annex", "owner");
  store.command(annexKey, "annex", { id: "annex-on", type: "room.public_receipts_set", data: { enabled: true } });
  store.command(annexKey, "annex", { id: "annex-msg", type: "message.posted",
    data: { messageId: "m-annex", body: "annex activity" } });
  const annexMirror = store.db.prepare(
    "SELECT enabled FROM room_public_receipts_setting WHERE room_id='annex'").get();
  assert.equal(annexMirror?.enabled, 1, "the annex mirror is written by its own sync and stays correct");
  assert.deepEqual(mirrorRow(store), { enabled: 0 }, "ROOM's poisoned mirror is NOT touched by the annex's writes");
  postMessage(ctx, "ordinary-1");
  assert.deepEqual(mirrorRow(store), { enabled: 1 }, "ROOM's own next write heals ROOM's mirror");
  const annexMirrorAfter = store.db.prepare(
    "SELECT enabled FROM room_public_receipts_setting WHERE room_id='annex'").get();
  assert.equal(annexMirrorAfter?.enabled, 1, "the annex mirror is unchanged by ROOM's heal");
  assert.ok(ownerKey, "owner key issued");
});
