import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Dot's ROUND-3 recheck of PR #5506 (muse-room seq 24323, verdict
// revoked by Jill at seq 24324) confirmed the round-2 gaps now fail
// closed, but found one regression the round-2 fix introduced: the
// genuinely-new-room exemption keys on the genesis event's body
// timestamp (genesisAt > snapshot.verified_at). A body timestamp is
// author-supplied data, not insertion-order evidence: a room that is
// genuinely absent from the store when the baseline is written — one
// whose events were constructed before the baseline but only
// initialized into the store after it, or whose genesis timestamp
// merely ties the baseline's verified_at — is judged "covered" and
// receives a durable baselineUnverifiable / projection_content
// failure: a false corruption verdict that sticks until an operator
// replaces the room's history.
// The cure decides newness on insertion order instead: the snapshot
// records the event log's insertion high-water mark (the events
// table's rowid sequence) at the moment the baseline is written, and
// a room whose first-inserted event entered the log after that mark
// was not covered by the baseline, whatever its bodies claim. The
// negative controls pin the other side: a room that WAS covered —
// its events entered the log before the mark — still fails closed
// when its remembered row is lost and its bytes are mutated.

const tick = store => store.verifyRoomIntegrity({ yieldBetween: async () => {} });

function openStore(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-integrity-dot3-"));
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

function verifiedAt(store) {
  return store.db.prepare("SELECT verified_at FROM integrity_snapshot WHERE id=1").get()?.verified_at;
}

function roomState(store, roomId) {
  return store.db.prepare("SELECT sequence, projection_bytes AS bytes, projection_hash AS hash FROM integrity_room_state WHERE room_id=?").get(roomId) ?? null;
}

function contentFailures(store, roomId) {
  return store.integrityFailures().filter(row => row.step === "projection_content" && row.recordId === roomId);
}

function mutateSameLength(store, roomId) {
  const row = store.db.prepare("SELECT projection, LENGTH(projection) AS bytes FROM rooms WHERE id=?").get(roomId);
  const tampered = row.projection.replace("Project Room Commons", "Project Room Commonz");
  assert.notEqual(tampered, row.projection);
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(tampered, roomId);
  assert.equal(store.db.prepare("SELECT LENGTH(projection) AS bytes FROM rooms WHERE id=?").get(roomId).bytes, row.bytes);
}

function roomWithGenesisAt(roomId, ms) {
  const events = initialRoom(roomId);
  for (const entry of events) entry.at = new Date(ms).toISOString();
  return events;
}

test("Dot round-3 3a: a genuinely new room whose genesis time EQUALS the baseline's verified_at verifies clean", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    assert.match(snapshotText(fixture.store), /^v2:/);
    // The room does not exist when the baseline is written; it is
    // initialized afterwards carrying a genesis timestamp that merely
    // ties the baseline's verified_at (same millisecond — e.g. an
    // agent that built its room in the same instant the cron ticked).
    fixture.store.initialize(roomWithGenesisAt("beta", verifiedAt(fixture.store)));
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 1, "a room absent at baseline time is baselined, not convicted by a tied timestamp");
    assert.equal(scan.baselineUnverifiable, undefined);
    assert.deepEqual(fixture.store.integrityFailures(), []);
    assert.ok(roomState(fixture.store, "beta")?.hash, "the new room carries a remembered baseline");
    const quiet = await tick(fixture.store);
    assert.equal(quiet.matched, 1);
  } finally { fixture.close(); }
});

test("Dot round-3 3b: a genuinely new room whose genesis time is 1ms BEFORE the baseline's verified_at verifies clean", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    assert.match(snapshotText(fixture.store), /^v2:/);
    fixture.store.initialize(roomWithGenesisAt("beta", verifiedAt(fixture.store) - 1));
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 1, "a 1ms-older body timestamp is not proof the baseline covered this room");
    assert.equal(scan.baselineUnverifiable, undefined);
    assert.deepEqual(fixture.store.integrityFailures(), []);
    assert.ok(roomState(fixture.store, "beta")?.hash, "the new room carries a remembered baseline");
    const quiet = await tick(fixture.store);
    assert.equal(quiet.matched, 1);
  } finally { fixture.close(); }
});

test("Dot round-3 3c: events constructed before the baseline but initialized after it verify clean", async () => {
  const fixture = openStore();
  try {
    // The room's events are CONSTRUCTED first — their body timestamps
    // predate everything the integrity job is about to write — and the
    // room is INITIALIZED (inserted into the store) only after the
    // baseline exists. Construction time is not insertion order.
    const beta = initialRoom("beta");
    await tick(fixture.store);
    await tick(fixture.store);
    assert.match(snapshotText(fixture.store), /^v2:/);
    const genesisAt = Date.parse(beta[0].at);
    assert.ok(genesisAt <= verifiedAt(fixture.store), "construction invariant: the bodies predate the baseline");
    const logHighWaterAtBaseline = fixture.store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM events").get().m;
    fixture.store.initialize(beta);
    const firstInserted = fixture.store.db.prepare("SELECT MIN(rowid) AS m FROM events WHERE room_id='beta'").get().m;
    assert.ok(firstInserted > logHighWaterAtBaseline,
      "insertion evidence: the room's first event entered the log after the baseline was written");
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 1, "insertion after the baseline — not body timestamps — decides coverage");
    assert.equal(scan.baselineUnverifiable, undefined);
    assert.deepEqual(fixture.store.integrityFailures(), []);
    assert.ok(roomState(fixture.store, "beta")?.hash, "the new room carries a remembered baseline");
  } finally { fixture.close(); }
});

test("Dot round-3 3d (negative control): a room covered by a later baseline still fails closed when its row is lost and its bytes mutated", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    fixture.store.initialize(initialRoom("beta"));
    const baselined = await tick(fixture.store);
    assert.equal(baselined.verified, 1, "the new room is baselined by the pass that covers it");
    assert.ok(roomState(fixture.store, "beta")?.hash);
    const covered = snapshotText(fixture.store);
    // Now beta IS covered: its events entered the log before the
    // current baseline's high-water mark. Losing its remembered row
    // and mutating its bytes is the round-2 gap (i) shape and must
    // still fail closed — the exemption is relative to the CURRENT
    // baseline, not a permanent "once new, always exempt".
    fixture.store.db.prepare("DELETE FROM integrity_room_state WHERE room_id='beta'").run();
    mutateSameLength(fixture.store, "beta");
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 0, "a covered room's mutated content must not be certified");
    assert.equal(scan.baselineUnverifiable, 1, "the covered room is reported unverifiable");
    assert.equal(scan.baselineUpgraded, undefined, "nothing may be adopted for a covered room");
    assert.equal(snapshotText(fixture.store), covered, "the snapshot must not advance over unverifiable content");
    assert.equal(roomState(fixture.store, "beta"), null, "the scan must not recreate the row from the mutated bytes");
    assert.equal(contentFailures(fixture.store, "beta").length, 1, "the failure stands as a durable record");
    const again = await tick(fixture.store);
    assert.equal(again.verified, 0);
    assert.equal(contentFailures(fixture.store, "beta").length, 1, "the failure persists across ticks until an authorised repair");
  } finally { fixture.close(); }
});

test("Dot round-3 3e (negative control): the originally baselined room still fails closed when its row is lost and its bytes mutated", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    const baseline = snapshotText(fixture.store);
    assert.match(baseline, /^v2:/);
    assert.ok(roomState(fixture.store, "alpha")?.hash);
    fixture.store.db.prepare("DELETE FROM integrity_room_state WHERE room_id='alpha'").run();
    mutateSameLength(fixture.store, "alpha");
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 0);
    assert.equal(scan.baselineUnverifiable, 1);
    assert.equal(scan.baselineUpgraded, undefined);
    assert.equal(snapshotText(fixture.store), baseline, "the snapshot must not advance over unverifiable content");
    assert.equal(roomState(fixture.store, "alpha"), null, "the scan must not recreate the row from the mutated bytes");
    assert.equal(contentFailures(fixture.store, "alpha").length, 1, "the failure stands as a durable record");
  } finally { fixture.close(); }
});

test("Dot round-3 3f (legacy bridge): a snapshot written before the insertion watermark existed still baselines a normal new room, and the next baseline records the watermark", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    assert.match(snapshotText(fixture.store), /^v2:/);
    // Simulate the pre-round-3 snapshot row: every baseline written
    // before this cure lacks the insertion high-water mark (NULL).
    fixture.store.db.prepare("UPDATE integrity_snapshot SET covered_event_rowid=NULL WHERE id=1").run();
    fixture.store.initialize(initialRoom("beta"));
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 1, "the legacy bridge (the round-2 timestamp test) still exempts an ordinary new room");
    assert.equal(scan.baselineUnverifiable, undefined);
    assert.deepEqual(fixture.store.integrityFailures(), []);
    const mark = fixture.store.db.prepare("SELECT covered_event_rowid AS m FROM integrity_snapshot WHERE id=1").get().m;
    assert.equal(typeof mark, "number", "the bridge is self-extinguishing: the new baseline records the insertion watermark");
  } finally { fixture.close(); }
});
