// Mirror read-time leg (B7-2-F1/F2/F4, B2-4-F1 — the settled-lot drift
// class, cured in the Ruling-40 shape).
//
// The lot read used to gate on the write-time mirror
// (room_public_receipts_setting), while the proof/room surfaces gated
// on a second mirror of the same setting (public_rooms.receipts_enabled)
// — and the two diverged within a single phase (B7-2-F4: the lot detail
// served on the stale lot mirror while the proof page 404'd on the
// fresh one). A desynced lot mirror changed public exposure in both
// directions and ordinary room activity could not heal it: a stale
// enabled=1 served a settled lot after the owner opted out — and after
// a restore/import dropped the recorded setting entirely (the
// wrongly-public polarity) — while a missing mirror hid a lot the
// owner had opted in. The audit specimens (phase-b B7-2 trace P5/P7b,
// B2-4 differ P1 minimal case) are re-run here as tests: seeding is
// through real entry points only (RoomStore commands + the escrow
// state machine); the direct DB writes are the audit's labelled
// control-plane ablations — mirror desync injection — never datum
// seeding.
//
// The cure: the lot read consults the authoritative recorded setting
// (rooms.projection $.room.publicReceipts.enabled) at read time, so
// lot-mirror drift cannot move a lot's public state — and the lot and
// proof surfaces, which disagreed under drift, agree again.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  publicReceiptById,
  loadPublicRoom,
  listPublicRoomSitemap,
  PUBLIC_READ_MODEL_SCHEMA,
} from "../server/public-read-model.mjs";
import { publicUnpublishSchema } from "../server/legal-store.mjs";
import { roomDirectorySchema } from "../server/room-directory.mjs";
import { lotReceiptVisible, recordedReceiptsSetting } from "../server/public-visibility.mjs";

function makeLot(t, tag) {
  const directory = mkdtempSync(join(tmpdir(), `project-room-mirror-${tag}-`));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: `add-ada-${tag}`, type: "member.added",
    data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  const escrow = store.bountyEscrow;
  escrow.ensureGenesis("commons");
  const bounty = escrow.postBounty("commons", { poster: "owner", title: "Fix the flaky export",
    criteria: "Export passes 100 runs in a row.", amount: 10,
    deadline: new Date(Date.now() + 86_400_000).toISOString() }).bounty;
  escrow.fundBounty("commons", bounty.bountyId, { funder: "owner" });
  escrow.claimBounty("commons", bounty.bountyId, { claimant: "ada" });
  escrow.submitWork("commons", bounty.bountyId, { claimant: "ada",
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  const rejected = escrow.rejectWork("commons", bounty.bountyId,
    { rejector: "owner", reason: "Export still flakes." });
  // The pre-opt-in backup, taken before any setting is recorded.
  const snapshot0 = [...store.exportEvents(ownerKey, "commons")];
  return { store, ownerKey, lotId: rejected.receipt.lotId, snapshot0 };
}

const setSetting = (ctx, id, enabled) => ctx.store.command(ctx.ownerKey, "commons",
  { id, type: "room.public_receipts_set", data: { enabled } });
const lotVisible = ctx => publicReceiptById(ctx.store, ctx.lotId) !== null;
const setMirror = (ctx, enabled) => ctx.store.db.prepare(
  "INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES ('commons', ?) ON CONFLICT(room_id) DO UPDATE SET enabled=excluded.enabled"
).run(enabled);

test("B7-2-F1: a stale mirror=1 cannot serve a lot after the owner opted out (P7b)", t => {
  const ctx = makeLot(t, "p7b");
  setSetting(ctx, "on-1", true);
  setSetting(ctx, "off-1", false);
  setMirror(ctx, 1); // ablation: the mirror claims ON, the record says OFF
  assert.equal(lotVisible(ctx), false, "the authoritative recorded-off decides, not the stale mirror");
});

test("B7-2-F1/F2: a missing mirror cannot hide an opted-in lot, and no heal is needed (P5)", t => {
  const ctx = makeLot(t, "p5");
  setSetting(ctx, "on-1", true);
  ctx.store.db.prepare("DELETE FROM room_public_receipts_setting WHERE room_id='commons'").run();
  assert.equal(lotVisible(ctx), true, "the authoritative recorded-on serves the lot with no mirror row");
  // Ordinary room activity is not a heal trigger and must not need to
  // be: the read follows the authoritative setting throughout.
  ctx.store.command(ctx.ownerKey, "commons", { id: "ordinary-1", type: "message.posted",
    data: { messageId: "m-ordinary-1", body: "ordinary activity" } });
  assert.equal(lotVisible(ctx), true, "ordinary activity neither heals nor breaks the read");
});

test("B2-4-F1: importing a pre-opt-in history cannot leave a lot public on a stale mirror", t => {
  const ctx = makeLot(t, "imp");
  setSetting(ctx, "on-1", true);
  assert.equal(lotVisible(ctx), true, "sanity: the opted-in lot serves before the import");
  ctx.store.importEvents(ctx.ownerKey, "commons", ctx.snapshot0);
  assert.equal(ctx.store.room("commons").state.room.publicReceipts ?? null, null,
    "the import dropped the recorded setting (never-recorded is private, #3594)");
  assert.equal(lotVisible(ctx), false, "the lot is private on the authoritative record, mirror notwithstanding");
  const mirrorRow = ctx.store.db.prepare(
    "SELECT enabled FROM room_public_receipts_setting WHERE room_id='commons'").get();
  assert.equal(mirrorRow, undefined, "the sync deletes the mirror row when the recorded setting is dropped");
});

test("B7-2-F4: under lot-mirror drift the lot and proof surfaces agree again", t => {
  const ctx = makeLot(t, "f4");
  ctx.store.command(ctx.ownerKey, "commons", { id: "page-on", type: "room.public_page_set", data: { enabled: true } });
  const proofEnabled = () => loadPublicRoom(ctx.store, "commons")?.receiptsEnabled
    ?? listPublicRoomSitemap(ctx.store).find(row => row.slug === "commons")?.receiptsEnabled;
  // The P7b shape: authoritative OFF, the public_rooms mirror fresh at
  // 0 (the toggle's own sync wrote it), the lot mirror stale at 1.
  // At base the surfaces diverged in this phase — lot served, proof
  // 404'd. With the lot read on the authoritative record, both hide.
  setSetting(ctx, "on-1", true);
  setSetting(ctx, "off-1", false);
  setMirror(ctx, 1); // ablation: stale lot mirror
  assert.equal(proofEnabled(), false, "the proof surface follows the recorded opt-out");
  assert.equal(lotVisible(ctx), proofEnabled(), "the lot surface agrees with the proof surface after opt-out");
  // The P5 shape: authoritative ON, the lot mirror row gone, the
  // public_rooms mirror at 1. At base the lot 404'd while the proof
  // surface stayed enabled. With the cure, both serve.
  setSetting(ctx, "on-2", true);
  ctx.store.db.prepare("DELETE FROM room_public_receipts_setting WHERE room_id='commons'").run();
  assert.equal(proofEnabled(), true, "the proof surface follows the recorded opt-in");
  assert.equal(lotVisible(ctx), proofEnabled(), "the lot surface agrees with the proof surface after opt-in");
});

test("recordedReceiptsSetting reads the authoritative leg and nothing else", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, projection TEXT NOT NULL)");
  const seed = (roomId, pub) => db.prepare("INSERT INTO rooms (id, projection) VALUES (?, ?)")
    .run(roomId, JSON.stringify({ room: { id: roomId, ...(pub === undefined ? {} : { publicReceipts: pub }) } }));
  seed("on-room", { enabled: true, revision: 3 });
  seed("off-room", { enabled: false, revision: 4 });
  seed("unrecorded-room", undefined);
  assert.deepEqual(recordedReceiptsSetting(db, "on-room"), { status: "recorded", enabled: 1 });
  assert.deepEqual(recordedReceiptsSetting(db, "off-room"), { status: "recorded", enabled: 0 });
  assert.deepEqual(recordedReceiptsSetting(db, "unrecorded-room"), { status: "recorded", enabled: null });
  assert.deepEqual(recordedReceiptsSetting(db, "gone-room"), { status: "absent", enabled: null });
});

test("lotReceiptVisible: the mirror decides only where no rooms table exists (legacy store)", () => {
  // A predating/partial store: no rooms table, so the mirror is the
  // only record that can exist — the conformance corpus's shape.
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(PUBLIC_READ_MODEL_SCHEMA);
  legacy.exec(publicUnpublishSchema);
  legacy.exec(roomDirectorySchema);
  assert.equal(recordedReceiptsSetting(legacy, "legacy-room").status, "unavailable");
  legacy.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES ('legacy-room', 1)").run();
  assert.equal(lotReceiptVisible(legacy, { id: "lot_0123456789abcdef", roomId: "legacy-room" }), true,
    "legacy store: a recorded mirror-on serves");
  legacy.prepare("UPDATE room_public_receipts_setting SET enabled=0 WHERE room_id='legacy-room'").run();
  assert.equal(lotReceiptVisible(legacy, { id: "lot_0123456789abcdef", roomId: "legacy-room" }), false,
    "legacy store: a recorded mirror-off hides");

  // The same mirror values with an authoritative record present: the
  // record alone decides, in both directions.
  const live = new DatabaseSync(":memory:");
  live.exec(PUBLIC_READ_MODEL_SCHEMA);
  live.exec(publicUnpublishSchema);
  live.exec(roomDirectorySchema);
  live.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, projection TEXT NOT NULL)");
  live.prepare("INSERT INTO rooms (id, projection) VALUES ('live-room', ?)")
    .run(JSON.stringify({ room: { id: "live-room", publicReceipts: { enabled: false, revision: 1 } } }));
  live.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES ('live-room', 1)").run();
  assert.equal(lotReceiptVisible(live, { id: "lot_0123456789abcdef", roomId: "live-room" }), false,
    "authoritative off beats a stale mirror-on");
  live.prepare("UPDATE rooms SET projection=? WHERE id='live-room'")
    .run(JSON.stringify({ room: { id: "live-room", publicReceipts: { enabled: true, revision: 2 } } }));
  live.prepare("UPDATE room_public_receipts_setting SET enabled=0 WHERE room_id='live-room'").run();
  assert.equal(lotReceiptVisible(live, { id: "lot_0123456789abcdef", roomId: "live-room" }), true,
    "authoritative on beats a stale mirror-off");
});
