import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { JOBS } from "../server/jobs.mjs";

// Dot's review of PR #5506 (muse-room seq 24285) found the L05-C1 content
// hash cure partial. These tests pin her four findings:
//  1. drift followed by an ordinary event must not clear the failure
//     while the changed bytes remain;
//  2. a v2 snapshot whose per-room hash is NULL must not verify-and-adopt
//     a mutated baseline;
//  3. reloading / rehydrating state must not manufacture a drift verdict
//     on unchanged content;
//  4. every baseline upgrade must reach the integrity job's log exactly
//     once (baselineUpgraded was dropped by the job's log allowlist).

const tick = store => store.verifyRoomIntegrity({ yieldBetween: async () => {} });

function openStore(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-integrity-dot-"));
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

function mutateSameLength(store) {
  const row = store.db.prepare("SELECT projection, LENGTH(projection) AS bytes FROM rooms WHERE id='alpha'").get();
  const tampered = row.projection.replace("Project Room Commons", "Project Room Commonz");
  assert.notEqual(tampered, row.projection);
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(tampered);
  assert.equal(store.db.prepare("SELECT LENGTH(projection) AS bytes FROM rooms WHERE id='alpha'").get().bytes, row.bytes);
  return row.projection;
}

function postOrdinaryMessage(store, id, body) {
  const key = store.issueAccessKey("alpha", "owner");
  return store.command(key, "alpha", { id, type: "message.posted", data: { body } });
}

test("Dot 1: drift followed by an ordinary event keeps failing while the changed bytes remain", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    const baseline = snapshotText(fixture.store);
    mutateSameLength(fixture.store);
    const drift = await tick(fixture.store);
    assert.equal(drift.contentDrift, 1);
    assert.equal(fixture.store.integrityFailures().filter(row => row.step === "projection_content").length, 1);

    assert.throws(()=>postOrdinaryMessage(fixture.store, "alpha-after-drift", "An ordinary event after the drift."), /projection_corrupt/);
    const stored = fixture.store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get().projection;
    assert.ok(stored.includes("Project Room Commonz"), "the drifted bytes are still in the stored projection");

    const after = await tick(fixture.store);
    assert.equal(after.verified, 0, "the tick after an ordinary event must not certify drifted content");
    assert.equal(after.matched, 0, "the drifted room must not be skipped as matched after an ordinary event");
    const failures = fixture.store.integrityFailures().filter(row => row.step === "projection_content" && row.recordId === "alpha");
    assert.equal(failures.length, 1, "the projection_content failure must persist while the changed bytes remain");
    assert.equal(snapshotText(fixture.store), baseline, "the baseline must not advance over drifted bytes");

    const again = await tick(fixture.store);
    assert.equal(again.verified, 0);
    assert.equal(again.matched, 0);
    assert.equal(fixture.store.integrityFailures().filter(row => row.step === "projection_content").length, 1);
    assert.equal(snapshotText(fixture.store), baseline);
  } finally { fixture.close(); }
});

test("Dot 2: a v2 snapshot with a NULL room hash does not verify-and-adopt mutated content", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    assert.match(snapshotText(fixture.store), /^v2:/);
    // The snapshot is v2, but this room's remembered hash is missing
    // (a state row the digest never reached): there is no content
    // baseline for the room, so its content cannot be certified.
    fixture.store.db.prepare("UPDATE integrity_room_state SET projection_hash=NULL WHERE room_id='alpha'").run();
    mutateSameLength(fixture.store);
    const scan = await tick(fixture.store);
    assert.equal(scan.verified, 0, "content with no remembered hash must not be certified");
    assert.equal(scan.matched, 0);
    assert.equal(scan.baselineUpgraded, undefined, "the independent write proof prevents adoption");
    assert.ok(fixture.store.integrityFailures().some(row=>row.step==='projection_content'), "the retained metadata proof exposes the corruption");
    const quiet = await tick(fixture.store);
    assert.equal(quiet.matched, 0, "unrepaired bytes are not adopted on a later scan");
  } finally { fixture.close(); }
});

test("Dot 3a: reopening the store does not manufacture drift on untouched content", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    await tick(fixture.store);
    fixture.store.close();
    const reopened = new RoomStore(fixture.filename);
    try {
      const scan = await tick(reopened);
      assert.equal(scan.matched, 1);
      assert.equal(scan.contentDrift, undefined);
      assert.deepEqual(reopened.integrityFailures(), []);
    } finally { reopened.close(); }
  } finally {
    rmSync(join(fixture.filename, ".."), { recursive: true, force: true });
  }
});

test("Dot 3b: rehydrating projections does not manufacture drift on unchanged content", async () => {
  const fixture = openStore({ bodiesAtRest: true });
  try {
    postOrdinaryMessage(fixture.store, "alpha-big", "x".repeat(300));
    const slimmed = fixture.store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get().projection;
    assert.ok(slimmed.includes("bodyRef"), "the stored projection holds the body at rest before rehydration");
    await tick(fixture.store);
    await tick(fixture.store);
    const sequenceBefore = fixture.store.db.prepare("SELECT sequence FROM rooms WHERE id='alpha'").get().sequence;
    const rewritten = fixture.store.rehydrateAllProjections();
    assert.ok(rewritten >= 1, "rehydration rewrote the slimmed projection");
    const restored = fixture.store.db.prepare("SELECT projection, sequence FROM rooms WHERE id='alpha'").get();
    assert.ok(!restored.projection.includes("bodyRef"), "rehydration restored the full body inline");
    assert.equal(restored.sequence, sequenceBefore, "rehydration does not move the sequence");
    const scan = await tick(fixture.store);
    assert.equal(scan.contentDrift, undefined, "a representation rewrite by the store itself is not content drift");
    assert.deepEqual(fixture.store.integrityFailures(), []);
    assert.ok(scan.verified === 1 || scan.matched === 1, "untouched content verifies or matches after rehydration");
    assert.equal(snapshotText(fixture.store), fixture.store.integrityChecksum().text);
  } finally { fixture.close(); }
});

test("Dot 4: the integrity job log carries each baseline upgrade exactly once", async () => {
  const fixture = openStore();
  try {
    await tick(fixture.store);
    // Pre-cure baseline shape: six-count snapshot and hash-less room state.
    const checksum = fixture.store.integrityChecksum();
    const legacy = [checksum.rooms, checksum.sequences, checksum.projectionBytes, checksum.invitations, checksum.journalEntries, checksum.journalSequences].join(":");
    fixture.store.db.prepare("UPDATE integrity_snapshot SET checksum=? WHERE id=1").run(legacy);
    fixture.store.db.prepare("UPDATE integrity_room_state SET projection_hash=NULL").run();

    const integrityJob = JOBS.find(job => job.name === "integrity");
    const lines = [];
    const originalInfo = console.info;
    const originalError = console.error;
    console.info = (...args) => lines.push(args.join(" "));
    console.error = () => {};
    try {
      await integrityJob.run(fixture.store, { deadline: Date.now() + 30000 });
      await integrityJob.run(fixture.store, { deadline: Date.now() + 30000 });
    } finally {
      console.info = originalInfo;
      console.error = originalError;
    }
    const integrityLines = lines
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(line => line?.event === "room.integrity");
    assert.ok(integrityLines.length >= 2, "both job ticks produced an integrity log line");
    const upgrades = integrityLines.filter(line => line.baselineUpgraded === 1);
    assert.equal(upgrades.length, 1, "the single baseline upgrade is logged exactly once, neither dropped nor repeated");
  } finally { fixture.close(); }
});
