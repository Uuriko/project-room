import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Dot's ROUND-2 recheck of PR #5506 (muse-room seq 24315, accepted by
// Jill at seq 24316) found two gaps the round-1 fixes did not close:
//  1. a v2-baselined room whose integrity_room_state row is MISSING
//     entirely (not just NULL), and rooms with empty-string hashes,
//     still verify and adopt mutated bytes — missing/empty baselines
//     must fail closed: no adoption, the failure stands, the room is
//     reported unverifiable, never certified;
//  2. a rehydrate edge (Dot3b-extension): a title mutated BEFORE any
//     detecting sweep, then rehydrated, verifies/adopts the drift —
//     the round-1 guard only protects rooms with an already-outstanding
//     drift record, so rehydration must not refresh a baseline whose
//     pre-rewrite bytes no longer match it.
// Controls pin the other side of both boundaries: a genuinely new room
// created through the normal path still baselines cleanly, and a
// missing row over unmutated content still matches on the digest.

const tick = store => store.verifyRoomIntegrity({ yieldBetween: async () => {} });

function openStore(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-integrity-dot2-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename, options);
  store.initialize(initialRoom("alpha"));
  return {
    store,
    filename,
    close() {
      try { store.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function snapshotText(store) {
  return store.db.prepare("SELECT checksum FROM integrity_snapshot WHERE id=1").get()?.checksum ?? null;
}

function roomState(store, roomId) {
  return store.db.prepare("SELECT sequence, projection_bytes AS bytes, projection_hash AS hash FROM integrity_room_state WHERE room_id=?").get(roomId) ?? null;
}

function mutateSameLength(store, roomId = "alpha") {
  const row = store.db.prepare("SELECT projection, LENGTH(projection) AS bytes FROM rooms WHERE id=?").get(roomId);
  const tampered = row.projection.replace("Project Room Commons", "Project Room Commonz");
  assert.notEqual(tampered, row.projection);
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(tampered, roomId);
  assert.equal(store.db.prepare("SELECT LENGTH(projection) AS bytes FROM rooms WHERE id=?").get(roomId).bytes, row.bytes);
  return row.projection;
}

function postMessage(store, roomId, id, body) {
  const key = store.issueAccessKey(roomId, "owner");
  return store.command(key, roomId, { id, type: "message.posted", data: { body } });
}

function contentFailures(store, roomId) {
  return store.integrityFailures().filter(row => row.step === "projection_content" && row.recordId === roomId);
}

test("Dot round-2 1a: a v2-baselined room whose state row is missing does not verify or adopt mutated content", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    const baseline = snapshotText(fixture.store);
    assert.match(baseline, /^v2:/);
    assert.ok(roomState(fixture.store, "alpha")?.hash, "the baseline carries a per-room hash before the loss");
    // Interrupted persistence / state loss: the snapshot is v2, but the
    // room's remembered row is gone entirely (not NULL — absent).
    fixture.store.db.prepare("DELETE FROM integrity_room_state WHERE room_id='alpha'").run();
    mutateSameLength(fixture.store);
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 0, "content whose baseline row is missing must not be certified");
    assert.equal(scan.matched, 0, "the room must not be skipped as matched");
    assert.equal(scan.baselineUpgraded, undefined, "a missing baseline is not an explicit upgrade — nothing may be adopted");
    assert.equal(scan.baselineUnverifiable, 1, "the room is reported unverifiable");
    assert.equal(snapshotText(fixture.store), baseline, "the snapshot must not advance over unverifiable content");
    assert.equal(roomState(fixture.store, "alpha"), null, "the scan must not recreate the row from the mutated bytes");
    assert.equal(contentFailures(fixture.store, "alpha").length, 1, "the failure stands as a durable record");
    const again = await tick(fixture.store);
    assert.equal(again.verified, 0);
    assert.equal(again.matched, 0);
    assert.equal(snapshotText(fixture.store), baseline);
    assert.equal(contentFailures(fixture.store, "alpha").length, 1, "the failure persists across ticks until an authorised repair");
    // The authorised repair: replace the room's history from its own
    // event log (importEvents rebuilds the projection from the log and
    // refreshes the room's baseline by construction).
    const lines = fixture.store.db.prepare("SELECT sequence, body FROM events WHERE room_id='alpha' ORDER BY sequence").all()
      .map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
    const key = fixture.store.issueAccessKey("alpha", "owner");
    fixture.store.importEvents(key, "alpha", lines);
    const repaired = await tick(fixture.store);
    assert.deepEqual(contentFailures(fixture.store, "alpha"), [], "the history replacement retires the failure");
    assert.ok(repaired.matched === 1 || repaired.verified === 1, "the log-rebuilt room verifies against its baseline again");
    const stored = fixture.store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get().projection;
    assert.ok(stored.includes("Project Room Commons"), "the mutated bytes are gone — the projection is the log's, not the mutation's");
    assert.ok(roomState(fixture.store, "alpha")?.hash, "the room has a remembered baseline again");
  } finally { fixture.close(); }
});

test("Dot round-2 1b: an empty-string room hash does not verify or adopt mutated content", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    const baseline = snapshotText(fixture.store);
    assert.match(baseline, /^v2:/);
    // A corrupted remembered row: the hash column holds an empty string,
    // which no writer in the codebase ever produces legitimately.
    fixture.store.db.prepare("UPDATE integrity_room_state SET projection_hash='' WHERE room_id='alpha'").run();
    mutateSameLength(fixture.store);
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 0, "content with an empty-string baseline hash must not be certified");
    assert.equal(scan.matched, 0);
    assert.equal(scan.baselineUpgraded, undefined, "an empty baseline is not an explicit upgrade — nothing may be adopted");
    assert.equal(scan.baselineUnverifiable, 1, "the room is reported unverifiable");
    assert.equal(snapshotText(fixture.store), baseline, "the snapshot must not advance over unverifiable content");
    assert.equal(roomState(fixture.store, "alpha")?.hash, "", "the scan must not replace the empty hash with the mutated bytes' hash");
    assert.equal(contentFailures(fixture.store, "alpha").length, 1, "the failure stands as a durable record");
    const again = await tick(fixture.store);
    assert.equal(again.verified, 0);
    assert.equal(snapshotText(fixture.store), baseline);
    assert.equal(roomState(fixture.store, "alpha")?.hash, "");
  } finally { fixture.close(); }
});

test("Dot round-2 1c (control): a missing state row over unmutated content still matches on the digest", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    const baseline = snapshotText(fixture.store);
    fixture.store.db.prepare("DELETE FROM integrity_room_state WHERE room_id='alpha'").run();
    const scan = await tick(fixture.store);
    assert.equal(scan.matched, 1, "the v2 digest still verifies untouched content globally — no failure is manufactured");
    assert.equal(scan.baselineUnverifiable, undefined);
    assert.deepEqual(fixture.store.integrityFailures(), []);
    assert.equal(snapshotText(fixture.store), baseline);
  } finally { fixture.close(); }
});

test("Dot round-2 2a: a title mutation before any detecting sweep is not laundered by rehydration", async () => {
  const fixture = openStore({ bodiesAtRest: true });
  try {
    postMessage(fixture.store, "alpha", "alpha-big", "x".repeat(300));
    const slimmed = fixture.store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get().projection;
    assert.ok(slimmed.includes("bodyRef"), "the stored projection holds the body at rest before rehydration");
    await tick(fixture.store);
    await tick(fixture.store);
    const baseline = snapshotText(fixture.store);
    const baselineHash = roomState(fixture.store, "alpha")?.hash;
    assert.ok(baselineHash, "the room is baselined before the mutation");
    // The mutation lands in place at an unchanged sequence and NO scan
    // runs after it: there is no outstanding drift record for the
    // round-1 rehydration guard to see.
    mutateSameLength(fixture.store);
    assert.deepEqual(fixture.store.integrityFailures(), [], "no detecting sweep has run — no drift record exists yet");
    assert.throws(()=>fixture.store.rehydrateAllProjections(),/projection_corrupt/, "rehydration refuses unverified old metadata");
    assert.equal(roomState(fixture.store, "alpha")?.hash, baselineHash,
      "rehydration must not refresh the baseline over bytes that no longer match it");
    const scan = await tick(fixture.store);
    assert.equal(scan.contentDrift, 1, "the pre-rehydration mutation is detected as drift, not adopted");
    assert.equal(scan.verified, 0);
    assert.equal(scan.matched, 0);
    assert.equal(snapshotText(fixture.store), baseline, "the baseline must not advance over the drifted bytes");
    assert.equal(contentFailures(fixture.store, "alpha").length, 1, "the drift stands as a durable record");
    assert.equal(roomState(fixture.store, "alpha")?.hash, baselineHash, "the remembered baseline is still the pre-mutation one");
  } finally { fixture.close(); }
});

test("Dot round-2 2b (control): a genuinely new room created through the normal path baselines cleanly in a v2 store", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    assert.match(snapshotText(fixture.store), /^v2:/);
    fixture.store.initialize(initialRoom("beta"));
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 1, "the new room is fully checked and baselined, not reported unverifiable");
    assert.equal(scan.baselineUnverifiable, undefined);
    assert.deepEqual(fixture.store.integrityFailures(), []);
    assert.equal(snapshotText(fixture.store), fixture.store.integrityChecksum().text);
    assert.ok(roomState(fixture.store, "beta")?.hash, "the new room carries a remembered baseline");
    const quiet = await tick(fixture.store);
    assert.equal(quiet.matched, 1);
  } finally { fixture.close(); }
});

test("Dot round-2 2c (control): rehydrating a genuinely new room does not adopt or corrupt its baseline", async () => {
  const fixture = openStore({ bodiesAtRest: true });
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    fixture.store.initialize(initialRoom("beta"));
    postMessage(fixture.store, "beta", "beta-big", "y".repeat(300));
    const slimmed = fixture.store.db.prepare("SELECT projection FROM rooms WHERE id='beta'").get().projection;
    assert.ok(slimmed.includes("bodyRef"), "the new room's stored projection holds the body at rest");
    const rewritten = fixture.store.rehydrateAllProjections();
    assert.ok(rewritten >= 1, "rehydration rewrote the new room's slimmed projection");
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 1, "the new room baselines cleanly after rehydration");
    assert.deepEqual(fixture.store.integrityFailures(), []);
    const quiet = await tick(fixture.store);
    assert.equal(quiet.matched, 1, "the adopted baseline composes on the next tick");
    assert.deepEqual(fixture.store.integrityFailures(), []);
  } finally { fixture.close(); }
});
