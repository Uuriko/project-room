// Lane B5 (P1 design §3.1/§3.2): call-site conversion to B4's durable
// content scanner + checksum sourcing. Pins, at the store seam:
//   - integrityChecksum sources a room's banked hash ONLY from a
//     completed durable scan at exactly the current bound (room
//     sequence + projection metadata digest);
//   - the stale-source trap: a digest-only projection move at an
//     unchanged sequence makes the banked proof stale — the checksum
//     must rescan, never compose the stale hash (coordinator R2/R5);
//   - incomplete and corrupt checkpoint rows source nothing;
//   - incrementalIntegrityCheck drives the durable scan under the tick
//     context: successive budget-spent calls bank checkpoint progress
//     and the snapshot advances only when the scan completes at its
//     bound (the T-L1b substance at seam scale; the 100k tick-level
//     acceptance is B7's overlay suite).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { projectionContentHash } from "../server/write-integrity.mjs";

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
  return { store, row, post };
}
const checkpoint = store =>
  store.db.prepare("SELECT * FROM integrity_content_scan_checkpoint WHERE room_id='commons'").get() ?? null;
const composeDigest = roomHashes => {
  const digest = createHash("sha256");
  for (const row of roomHashes) digest.update(row.id).update("\0").update(row.hash).update("\n");
  return digest.digest("hex");
};
const freshDigest = store => {
  const row = store.db.prepare("SELECT sequence, projection FROM rooms WHERE id='commons'").get();
  return composeDigest([{ id: "commons", hash: projectionContentHash(store.db, "commons", row.sequence, row.projection) }]);
};
const spent = { deadline: Date.now() - 1 };

test("checksum sources a completed banked proof at the current bound instead of rescanning", async t => {
  const { store } = fixtureStore(t);
  const done = await store.driveRoomContentScan("commons");
  assert.equal(done.done, 1);
  // Adoption-gated banking: the completed scan's hash enters the
  // remembered state through the verified remember path; only then is
  // it sourceable.
  store.rememberIntegrityRoomState();
  const sourced = store.integrityChecksum();
  assert.equal(sourced.contentHash, composeDigest([{ id: "commons", hash: done.hash }]),
    "the checksum composes the banked hash");
  // Tamper a canonical message row behind the projection's back: a
  // fresh scan's hash moves, the banked proof (bound unchanged) does
  // not — a checksum that still reports the banked composition proves
  // it sourced the banked hash instead of rescanning.
  store.db.prepare("UPDATE messages SET body='tampered-behind-the-proof' WHERE room_id='commons' AND message_id='m-00001'").run();
  assert.notEqual(freshDigest(store), sourced.contentHash, "a fresh scan would report a different digest");
  assert.equal(store.integrityChecksum().contentHash, sourced.contentHash,
    "the checksum sourced the banked proof at its bound, not a rescan");
});

test("forged done checkpoint is never sourced: the remembered state gates the composition", async t => {
  const { store } = fixtureStore(t);
  const done = await store.driveRoomContentScan("commons");
  assert.equal(done.done, 1);
  store.rememberIntegrityRoomState();
  const forged = "f".repeat(64);
  store.db.prepare("UPDATE integrity_content_scan_checkpoint SET result_hash=? WHERE room_id='commons'").run(forged);
  const after = store.integrityChecksum();
  assert.notEqual(after.contentHash, composeDigest([{ id: "commons", hash: forged }]),
    "a planted result_hash on a done checkpoint row is not composed");
  assert.equal(after.contentHash, freshDigest(store),
    "the disagreement refuses sourcing and the room is scanned fresh");
});

test("v2 window: remembered v2-definition hashes are never sourced into the v3 checksum", async t => {
  const { store, row } = fixtureStore(t);
  const { projectionContentHashV2 } = await import("../server/write-integrity.mjs");
  const v2Hash = projectionContentHashV2(store.db, "commons", row.sequence, row.projection);
  store.db.prepare("UPDATE integrity_room_state SET projection_hash=? WHERE room_id='commons'").run(v2Hash);
  store.db.prepare("INSERT INTO integrity_snapshot(id, checksum, verified_at) VALUES(1, ?, 0) ON CONFLICT(id) DO UPDATE SET checksum=excluded.checksum")
    .run(`v2:1:${row.sequence}:100:0:0:0:${"0".repeat(64)}`);
  const after = store.integrityChecksum();
  assert.notEqual(after.contentHash, composeDigest([{ id: "commons", hash: v2Hash }]),
    "the v2-definition hash is not composed into the v3 checksum");
  assert.equal(after.contentHash, freshDigest(store), "the room is scanned fresh under the current definition");
});

test("stale-source trap: a digest-only projection move at an unchanged sequence is never sourced", async t => {
  const { store, row } = fixtureStore(t);
  const done = await store.driveRoomContentScan("commons");
  assert.equal(done.done, 1);
  store.rememberIntegrityRoomState();
  const bankedComposition = composeDigest([{ id: "commons", hash: done.hash }]);
  assert.equal(store.integrityChecksum().contentHash, bankedComposition);
  // Digest-only move: same sequence, different projection bytes (a
  // metadata-only edit). The banked bound's digest half no longer
  // matches, so the banked hash is stale even though the sequence
  // stands still.
  const state = JSON.parse(row.projection);
  state.room.name = "Renamed Room";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));
  const after = store.integrityChecksum();
  assert.notEqual(after.contentHash, bankedComposition,
    "the checksum must not compose the stale banked hash after a digest-only move");
  assert.equal(after.contentHash, freshDigest(store),
    "the checksum rescanned the room whose banked proof went stale");
});

test("incomplete and corrupt checkpoint rows source nothing", async t => {
  const { store } = fixtureStore(t, { messages: 450 });
  const partial = await store.driveRoomContentScan("commons", spent);
  assert.equal(partial.checkpointBanked, 1);
  assert.equal(checkpoint(store).phase, "messages");
  assert.equal(checkpoint(store).result_hash, null);
  assert.equal(store.integrityChecksum().contentHash, freshDigest(store),
    "a partial scan's progress is never sourced as a proof");
  const done = await store.driveRoomContentScan("commons");
  assert.equal(done.done, 1);
  store.db.prepare("UPDATE integrity_content_scan_checkpoint SET range_digests_json='not-json' WHERE room_id='commons'").run();
  assert.equal(store.integrityChecksum().contentHash, freshDigest(store),
    "a corrupt checkpoint row sources nothing; the checksum rescans");
});

test("incremental legs drive the durable scan: progress banks per spent call, the snapshot advances only at completion", async t => {
  const { store, post } = fixtureStore(t, { messages: 450 });
  const tick = (opts = {}) => store.verifyRoomIntegrity({ yieldBetween: async () => {}, ...opts });
  const settle1 = await tick();
  assert.equal(settle1.verified, 1);
  const settle2 = await tick();
  assert.equal(settle2.matched, 1);
  const settledSnapshot = store.readIntegritySnapshot();
  // Grow the room through the write path: the changed-room leg owes a
  // new proof at the new head.
  for (let i = 450; i < 460; i++) post(`m-${String(i).padStart(5, "0")}`);
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;

  const first = await store.incrementalIntegrityCheck(spent);
  assert.equal(first.ok, false, "a budget-spent incremental completes no proof");
  assert.equal(first.contentScanProgress, "commons");
  assert.equal(checkpoint(store).range_cursor, "m-00199", "range 1 banked durably");
  assert.equal(checkpoint(store).bound_seq, head, "the banked scan is bound to the grown head");
  assert.equal(store.readIntegritySnapshot(), settledSnapshot,
    "the snapshot does not advance while the scan is incomplete");

  const second = await store.incrementalIntegrityCheck(spent);
  assert.equal(second.ok, false);
  assert.equal(checkpoint(store).range_cursor, "m-00399", "a new scanner instance resumed and banked range 2");
  assert.equal(store.readIntegritySnapshot(), settledSnapshot);

  const completed = await store.incrementalIntegrityCheck();
  assert.equal(completed.ok, true, "the resumed scan completes and the incremental check certifies");
  assert.equal(completed.checked, 1, "exactly the changed room was served");
  const advanced = store.readIntegritySnapshot();
  assert.notEqual(advanced, settledSnapshot);
  assert.equal(Number(advanced.split(":")[2]), head,
    "the snapshot advanced in one step to the completed scan's bound");
  assert.equal(store.integrityChecksum().text, advanced);
  assert.deepEqual(store.integrityFailures(), [], "no failure is recorded for a clean resumed proof");
});

// Recheck regression pins (B5 recheck #2 defect): the remembered state
// the TICK banks is not a completed durable scan, and for a migrated
// room the (sequence, projection metadata digest) bound does not cover
// the canonical payload bytes the hash was computed over. Sourcing that
// state anyway composed a stale hash over a payload-only tamper — the
// checksum stayed invariant and the tamper went undetected (the three
// integrity-reconciliation pins that pass at B4 and failed at the first
// B5 head). Sourcing now requires a completed scan at the bound that
// agrees with the remembered hash.
test("tick-banked state without a completed scan sources nothing: a payload-only tamper of a migrated room moves the checksum", async t => {
  const { store } = fixtureStore(t, { messages: 10 });
  const tick = () => store.verifyRoomIntegrity({ yieldBetween: async () => {} });
  await tick();
  const settled = await tick();
  assert.equal(settled.matched, 1, "fixture: the tick-banked baseline is settled");
  const before = store.integrityChecksum().text;
  // Equal-length, in-place canonical payload rewrite: body and its
  // record_json copy move together; the sequence, the projection and
  // every bound input stand still.
  store.db.prepare("UPDATE messages SET body=?, record_json=json_set(record_json,'$.body',?) WHERE room_id='commons' AND message_id='m-00001'")
    .run("y".repeat(200), "y".repeat(200));
  assert.notEqual(store.integrityChecksum().text, before,
    "no completed scan stands at the bound, so the checksum rescans and the tamper moves it");
  const result = await tick();
  assert.equal(result.verified, 0);
  assert.ok(store.integrityFailures().some(f => f.recordId === "commons" && f.step === "projection_content"),
    "the tick records the payload drift it detected");
});

test("a completed banked verdict for a migrated room is not re-issued after a payload-only rewrite at an unchanged bound", async t => {
  const { store } = fixtureStore(t, { messages: 60 });
  const done = await store.driveRoomContentScan("commons");
  assert.equal(done.done, 1);
  assert.equal(done.drift, false);
  const original = store.db.prepare("SELECT body, record_json FROM messages WHERE room_id='commons' AND message_id='m-00001'").get();
  store.db.prepare("UPDATE messages SET body=?, record_json=json_set(record_json,'$.body',?) WHERE room_id='commons' AND message_id='m-00001'")
    .run("y".repeat(200), "y".repeat(200));
  const rescanned = await store.driveRoomContentScan("commons");
  assert.equal(rescanned.done, 1);
  assert.equal(rescanned.drift, true, "the drive rescanned and caught the payload drift instead of issuing the banked clean verdict");
  assert.notEqual(rescanned.hash, done.hash, "the rescanned hash follows the tampered payload bytes");
  // Repair the payload at the same unchanged bound: the banked drift
  // verdict must not poison the repaired room either.
  store.db.prepare("UPDATE messages SET body=?, record_json=? WHERE room_id='commons' AND message_id='m-00001'")
    .run(original.body, original.record_json);
  const repaired = await store.driveRoomContentScan("commons");
  assert.equal(repaired.done, 1);
  assert.equal(repaired.drift, false, "the repaired room rescans clean instead of inheriting the banked drift verdict");
  assert.equal(repaired.hash, done.hash, "the repaired room's hash returns to the banked truth");
});
