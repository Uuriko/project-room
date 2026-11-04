// Lane B4 (P1 design §3.2 durable progress / §3.4 schema flag): the
// content-scan checkpoint. B2's chunked scanner, carrying B3's ranged
// composition, banks per-range digests into the additive table
// integrity_content_scan_checkpoint; a NEW scanner instance resumes
// from the durable row; chunk commits and the final baseline adoption
// are CAS on (room_id, attempt_seq) with the scan bound (room sequence
// + projection metadata digest at scan start) still current; bound
// moved / corrupt row -> discard, count (scanDiscards), restart; room
// deleted -> moot-swept. No verdict is ever issued from a partial scan.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, CONTENT_SCAN_CHECKPOINT_BYTES } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  servingContentProof, projectionContentHash, projectionContentHashV2,
} from "../server/write-integrity.mjs";

function fixtureStore(t, { messages = 250, bodyBytes = 200 } = {}) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  const owner = store.issueAccessKey("commons", "owner");
  let now = Date.now() + 10000;
  store.now = () => now;
  const body = "x".repeat(bodyBytes);
  const post = id => {
    now += 2001;
    store.command(owner, "commons", { id, type: "message.posted", data: { messageId: id, body } });
  };
  for (let i = 0; i < messages; i++) post(`m-${String(i).padStart(5, "0")}`);
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  assert.equal(store.checkMessagesParity({ roomId: "commons" }).ok, true);
  store.migrateMessageAuthority("commons");
  const row = store.db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get("commons");
  assert.equal(JSON.parse(row.projection).messageAuthority.count, messages);
  return { store, row, post };
}
const checkpoint = (store, roomId = "commons") =>
  store.db.prepare("SELECT * FROM integrity_content_scan_checkpoint WHERE room_id=?").get(roomId) ?? null;
const storedHash = (store, roomId = "commons") =>
  store.db.prepare("SELECT projection_hash AS hash FROM integrity_room_state WHERE room_id=?").get(roomId)?.hash;
const spent = { deadline: Date.now() - 1 };

test("(a) seam-level resume: budget-stopped drives bank ranges durably; a new scanner instance resumes and completes with the sync verdict", async t => {
  const { store, row } = fixtureStore(t, { messages: 450 });
  const sync = servingContentProof(store.db, "commons", row.sequence, row.projection);
  const first = await store.driveRoomContentScan("commons", spent);
  assert.equal(first.checkpointBanked, 1);
  assert.equal(first.hash, undefined, "a partial drive issues no verdict: no hash");
  assert.equal(first.drift, undefined, "a partial drive issues no verdict: no drift");
  let banked = checkpoint(store);
  assert.equal(banked.bound_seq, row.sequence, "scan bound = room sequence at scan start");
  assert.equal(banked.range_cursor, "m-00199", "range cursor = last message id banked (range 1 closes at row 200)");
  assert.equal(JSON.parse(banked.range_digests_json).length, 1);
  assert.equal(banked.attempt_seq, 1);
  const second = await store.driveRoomContentScan("commons", spent);
  assert.equal(second.checkpointBanked, 1);
  banked = checkpoint(store);
  assert.equal(banked.range_cursor, "m-00399", "the resumed (new) scanner banked range 2 without re-reading range 1");
  const done = await store.driveRoomContentScan("commons");
  assert.equal(done.done, 1);
  assert.equal(done.drift, false);
  assert.equal(done.hash, sync.hash, "the resumed scan's verdict/hash is identical to the sync drive");
  assert.deepEqual(done.rangeDigests, sync.rangeDigests);
  banked = checkpoint(store);
  assert.equal(banked.phase, "done");
  assert.equal(banked.result_hash, sync.hash);
  assert.equal(JSON.parse(banked.range_digests_json).length, 3, "450 rows bank 3 ranges (200 + 200 + 50)");
});

test("(b) CAS fencing: a stale attempt_seq pin is rejected for chunk commits and for adoption; the current attempt adopts", async t => {
  const { store } = fixtureStore(t, { messages: 250 });
  const first = await store.driveRoomContentScan("commons", spent);
  assert.equal(first.attemptSeq, 1);
  const stale = await store.driveRoomContentScan("commons", { attemptSeq: 99 });
  assert.equal(stale.casRejected, 1);
  assert.equal(stale.reason, "stale_attempt");
  assert.equal(checkpoint(store).range_cursor, "m-00199", "the rejected drive banked nothing");
  const done = await store.driveRoomContentScan("commons");
  assert.equal(done.done, 1);
  const baselineBefore = storedHash(store);
  const staleAdopt = store.adoptContentScanBaseline("commons", { attemptSeq: 99 });
  assert.equal(staleAdopt.adopted, 0);
  assert.equal(staleAdopt.reason, "stale_attempt");
  assert.equal(storedHash(store), baselineBefore, "a stale adoption writes no baseline");
  assert.ok(checkpoint(store), "a stale adoption does not consume the checkpoint");
  const adopted = store.adoptContentScanBaseline("commons", { attemptSeq: 1 });
  assert.equal(adopted.adopted, 1);
  assert.equal(adopted.hash, done.hash);
  assert.equal(storedHash(store), done.hash, "the per-room baseline is the completed scan's v3 hash");
  assert.equal(checkpoint(store), null, "adoption consumes the checkpoint under its CAS");
});

test("(c) discard semantics: bound moved mid-scan discards, counts, and restarts at the new bound", async t => {
  const { store, post } = fixtureStore(t, { messages: 250 });
  await store.driveRoomContentScan("commons", spent);
  assert.equal(checkpoint(store).range_cursor, "m-00199");
  post("m-00250");
  const moved = store.db.prepare("SELECT sequence, projection FROM rooms WHERE id='commons'").get();
  const restarted = await store.driveRoomContentScan("commons", spent);
  assert.ok(restarted.scanDiscards >= 1, "the stale-bound row was discarded and counted");
  const banked = checkpoint(store);
  assert.equal(banked.bound_seq, moved.sequence, "the restarted scan is bound to the new head");
  assert.equal(banked.attempt_seq, 2, "the restart carries a fresh attempt generation");
  assert.equal(banked.range_cursor, "m-00199", "the restarted scan banks from the beginning of the room");
  const done = await store.driveRoomContentScan("commons");
  assert.equal(done.hash, servingContentProof(store.db, "commons", moved.sequence, moved.projection).hash);
});

test("(c) discard semantics: a corrupt checkpoint row is discarded, counted, and the scan restarts clean", async t => {
  const { store, row } = fixtureStore(t, { messages: 250 });
  await store.driveRoomContentScan("commons", spent);
  store.db.prepare("UPDATE integrity_content_scan_checkpoint SET range_digests_json='not json' WHERE room_id='commons'").run();
  const restarted = await store.driveRoomContentScan("commons", spent);
  assert.ok(restarted.scanDiscards >= 1, "the corrupt row was discarded and counted (scanDiscards)");
  assert.equal(checkpoint(store).attempt_seq, 2);
  assert.equal(checkpoint(store).range_cursor, "m-00199", "the scan restarted from the room's start, not from corrupt state");
  const done = await store.driveRoomContentScan("commons");
  assert.equal(done.hash, servingContentProof(store.db, "commons", row.sequence, row.projection).hash,
    "the restarted scan's verdict matches the sync drive — corruption never certifies anything");
});

test("(c) discard semantics: a deleted room's checkpoint is moot-swept and its drive is moot", async t => {
  const { store } = fixtureStore(t, { messages: 10 });
  store.contentScanCheckpointRow("ghost"); // ensures the table exists
  store.db.prepare(`INSERT INTO integrity_content_scan_checkpoint
    (room_id, attempt_seq, phase, bound_seq, bound_digest, updated_at) VALUES('ghost', 1, 'messages', 5, ?, 1)`)
    .run("a".repeat(64));
  const moot = await store.driveRoomContentScan("ghost");
  assert.equal(moot.moot, 1);
  assert.equal(checkpoint(store, "ghost"), null, "the moot row is swept by the drive");
  store.db.prepare(`INSERT INTO integrity_content_scan_checkpoint
    (room_id, attempt_seq, phase, bound_seq, bound_digest, updated_at) VALUES('ghost', 1, 'messages', 5, ?, 1)`)
    .run("a".repeat(64));
  store.rememberIntegrityRoomState();
  assert.equal(checkpoint(store, "ghost"), null, "the moot row is swept with the room's other integrity state");
});

test("(d) adoption CAS: the bound moving between completion and adoption blocks adoption and discards the scan", async t => {
  const { store, post } = fixtureStore(t, { messages: 250 });
  await store.driveRoomContentScan("commons");
  assert.equal(checkpoint(store).phase, "done");
  const baselineBefore = storedHash(store);
  post("m-00250");
  const blocked = store.adoptContentScanBaseline("commons", { attemptSeq: 1 });
  assert.equal(blocked.adopted, 0);
  assert.equal(blocked.reason, "bound_moved");
  assert.equal(storedHash(store), baselineBefore, "no baseline is adopted from a scan whose bound moved");
  const banked = checkpoint(store);
  assert.equal(banked.phase, "messages", "the stale completed scan is discarded back to a fresh attempt");
  assert.equal(banked.attempt_seq, 2);
  assert.ok(banked.scan_discards >= 1);
});

test("no verdict from a partial scan: adoption of an incomplete checkpoint is refused", async t => {
  const { store } = fixtureStore(t, { messages: 250 });
  await store.driveRoomContentScan("commons", spent);
  const baselineBefore = storedHash(store);
  const refused = store.adoptContentScanBaseline("commons", { attemptSeq: 1 });
  assert.equal(refused.adopted, 0);
  assert.equal(refused.reason, "incomplete");
  assert.equal(storedHash(store), baselineBefore);
});

// --- (d) B3's transition semantics re-verified riding the CAS ---------
function openAlpha(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-b4-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("alpha"));
  return store;
}
const tick = store => store.verifyRoomIntegrity({ yieldBetween: async () => {} });
function v2SnapshotDigest(store) {
  const digest = createHash("sha256");
  for (const row of store.db.prepare("SELECT room_id AS id, projection_hash AS hash FROM integrity_room_state ORDER BY room_id").all()) {
    digest.update(row.id).update("\0").update(row.hash).update("\n");
  }
  return digest.digest("hex");
}
function downgradeToV2Baseline(store) {
  const update = store.db.prepare("UPDATE integrity_room_state SET projection_hash=? WHERE room_id=?");
  for (const row of store.db.prepare("SELECT id, sequence, projection FROM rooms ORDER BY id").all()) {
    update.run(projectionContentHashV2(store.db, row.id, row.sequence, row.projection), row.id);
  }
  const checksum = store.integrityChecksum();
  const text = ["v2", checksum.rooms, checksum.sequences, checksum.projectionBytes,
    checksum.invitations, checksum.journalEntries, checksum.journalSequences, v2SnapshotDigest(store)].join(":");
  store.db.prepare("UPDATE integrity_snapshot SET checksum=? WHERE id=1").run(text);
  return text;
}

test("(d) adoption CAS: B3's v2->v3 transition rides the CAS — a completed checkpoint is consumed by the adoption transaction", async t => {
  const store = openAlpha(t);
  await tick(store);
  await tick(store);
  const scan = await store.driveRoomContentScan("alpha");
  assert.equal(scan.done, 1);
  assert.equal(scan.hash, projectionContentHash(store.db, "alpha",
    store.db.prepare("SELECT sequence FROM rooms WHERE id='alpha'").get().sequence,
    store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get().projection));
  assert.equal(checkpoint(store, "alpha").phase, "done");
  downgradeToV2Baseline(store);
  const transition = await tick(store);
  assert.equal(transition.verified, 0, "the transition scan certifies nothing");
  assert.equal(transition.baselineUpgraded, 1, "the v3 baseline adoption is explicit");
  assert.equal(transition.scanDiscards, undefined, "a current, agreeing checkpoint is consumed, not discarded");
  assert.equal(checkpoint(store, "alpha"), null, "the adoption transaction consumed the completed checkpoint under its CAS");
  assert.match(store.readIntegritySnapshot(), /^v3:/);
});

test("(d) adoption CAS: a completed checkpoint that disagrees with the fresh audit is discarded, never an audit input", async t => {
  const store = openAlpha(t);
  await tick(store);
  await tick(store);
  const scan = await store.driveRoomContentScan("alpha");
  assert.equal(scan.done, 1);
  store.db.prepare("UPDATE integrity_content_scan_checkpoint SET result_hash=? WHERE room_id='alpha'").run("b".repeat(64));
  downgradeToV2Baseline(store);
  const transition = await tick(store);
  assert.equal(transition.verified, 0);
  assert.equal(transition.baselineUpgraded, 1, "adoption proceeds on the fresh audit alone");
  assert.equal(transition.scanDiscards, 1, "the disagreeing checkpoint was discarded and counted");
  assert.equal(checkpoint(store, "alpha"), null);
  assert.equal(storedHash(store, "alpha"), scan.hash, "the adopted baseline is the audit's hash, not the checkpoint's tampered one");
});

test("(5) checkpoint payload discipline: serialized size stays under CHECKPOINT_BYTES with the 100k-room arithmetic", async t => {
  assert.equal(CONTENT_SCAN_CHECKPOINT_BYTES, 256 * 1024);
  // 100,000 rows / 200 rows per range = 500 ranges; each banked digest
  // is a fixed 64-char hex string (67 bytes in the JSON array).
  const digestsJson = JSON.stringify(Array.from({ length: 500 }, () => "a".repeat(64)));
  assert.equal(digestsJson.length, 500 * 67 + 1);
  assert.ok(digestsJson.length + 512 < CONTENT_SCAN_CHECKPOINT_BYTES,
    "a 100k-room checkpoint payload is ~34 KB against the 256 KiB bound");
  const { store } = fixtureStore(t, { messages: 250 });
  await store.driveRoomContentScan("commons");
  const banked = checkpoint(store);
  const serialized = JSON.stringify(banked).length;
  assert.ok(serialized <= CONTENT_SCAN_CHECKPOINT_BYTES, `banked row serializes to ${serialized} B`);
});
