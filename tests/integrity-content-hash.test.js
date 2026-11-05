import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// L05-C1: the integrity checksum used to be counts and byte lengths only,
// so a same-length in-place projection mutation was certified verified,
// snapshotted as the new baseline, and skipped as matched thereafter.
// These tests pin the content-hash cure: the snapshot carries a sha256
// digest over the projection content, post-baseline content drift fails
// verification and is never adopted, and a baseline established without
// a prior digest is reported as an explicit upgrade, never as verified.

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "project-room-integrity-hash-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  return {
    store,
    close() {
      store.close();
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

test("the first scan on a never-baselined store writes a v2 digest snapshot", async () => {
  const fixture = openStore();
  try {
    const first = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(first.verified, 1);
    assert.match(snapshotText(fixture.store), /^v2:1:2:\d+:0:0:0:[0-9a-f]{64}$/);
    assert.equal(snapshotText(fixture.store), fixture.store.integrityChecksum().text);
    const quiet = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(quiet.matched, 1);
    assert.equal(quiet.verified, 0);
    assert.deepEqual(fixture.store.integrityFailures(), []);
  } finally { fixture.close(); }
});

test("a same-length projection mutation after the baseline fails verification and is never adopted", async () => {
  const fixture = openStore();
  try {
    await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    const baseline = snapshotText(fixture.store);
    mutateSameLength(fixture.store);
    const first = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(first.verified, 0);
    assert.equal(first.matched, 0);
    assert.equal(first.contentDrift, 1);
    const failures = fixture.store.integrityFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].step, "projection_content");
    assert.equal(failures[0].recordId, "alpha");
    assert.equal(snapshotText(fixture.store), baseline, "the mutated bytes are not adopted as the baseline");
    const second = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(second.verified, 0);
    assert.equal(second.matched, 0, "the drifted room is never skipped as matched");
    assert.equal(snapshotText(fixture.store), baseline);
  } finally { fixture.close(); }
});

test("repairing the drifted bytes clears the failure and matches the baseline again", async () => {
  const fixture = openStore();
  try {
    await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    const original = mutateSameLength(fixture.store);
    const failed = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(failed.contentDrift, 1);
    fixture.store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(original);
    const repaired = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(repaired.matched, 1);
    assert.deepEqual(fixture.store.integrityFailures(), []);
  } finally { fixture.close(); }
});

test("a legacy baseline recorded over mutated bytes is not certified on the transition scan", async () => {
  const fixture = openStore();
  try {
    await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    // Pre-cure state over mutated bytes: the six-count snapshot the old
    // code would have written (counts and lengths are unchanged by the
    // mutation, so the legacy text is identical) and hash-less room state.
    mutateSameLength(fixture.store);
    const checksum = fixture.store.integrityChecksum();
    const legacy = [checksum.rooms, checksum.sequences, checksum.projectionBytes, checksum.invitations, checksum.journalEntries, checksum.journalSequences].join(":");
    fixture.store.db.prepare("UPDATE integrity_snapshot SET checksum=? WHERE id=1").run(legacy);
    fixture.store.db.prepare("UPDATE integrity_room_state SET projection_hash=NULL").run();
    const transition = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(transition.verified, 0, "the transition scan certifies nothing against a digest-less baseline");
    assert.equal(transition.matched, 0);
    assert.equal(transition.baselineUpgraded, 1, "the digest baseline adoption is explicit, not silent");
    assert.match(snapshotText(fixture.store), /^v2:/);
  } finally { fixture.close(); }
});

test("a legacy counts-only baseline is upgraded explicitly, never matched or certified", async () => {
  const fixture = openStore();
  try {
    await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    // Reconstruct the pre-cure state: a six-count snapshot and room state
    // rows with no content hash.
    const checksum = fixture.store.integrityChecksum();
    const legacy = [checksum.rooms, checksum.sequences, checksum.projectionBytes, checksum.invitations, checksum.journalEntries, checksum.journalSequences].join(":");
    fixture.store.db.prepare("UPDATE integrity_snapshot SET checksum=? WHERE id=1").run(legacy);
    fixture.store.db.prepare("UPDATE integrity_room_state SET projection_hash=NULL").run();
    const transition = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(transition.matched, 0, "a digest-less baseline never matches");
    assert.equal(transition.verified, 0, "a digest-less baseline never certifies the transition scan");
    assert.equal(transition.baselineUpgraded, 1);
    assert.match(snapshotText(fixture.store), /^v2:/);
    const quiet = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(quiet.matched, 1, "the upgraded digest baseline is authoritative from the next scan");
  } finally { fixture.close(); }
});

test("a legitimate event still verifies through the incremental path with the digest in step", async () => {
  const fixture = openStore();
  try {
    await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    const key = fixture.store.issueAccessKey("alpha", "owner");
    fixture.store.command(key, "alpha", { id: "alpha-note", type: "message.posted", data: { body: "Legitimate move." } });
    const tick = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(tick.matched, 1);
    assert.equal(tick.checked, 1);
    assert.equal(snapshotText(fixture.store), fixture.store.integrityChecksum().text);
    assert.deepEqual(fixture.store.integrityFailures(), []);
  } finally { fixture.close(); }
});
