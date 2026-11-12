import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  CONTENT_HASH_RANGE_ROWS,
  composeContentHash,
  contentRangeDigest,
  projectionContentHash,
  projectionContentHashV2,
  projectionDigest,
  servingContentProof
} from "../server/write-integrity.mjs";

// P1 §3.2 / §5 T-L1c (B3 lane): the content hash is redefined as a
// composition of per-range digests (snapshot format v3). These tests pin:
//  - the composition itself (range digests in order, bound to room id,
//    sequence and the projection digest);
//  - the drift half of T-L1c at the v3 baseline: in-place byte drift at
//    an unchanged sequence is still detected, recorded projection_content,
//    and never adopted (non-regression pin — this half passed at base
//    under v2 and must keep passing);
//  - the transition half of T-L1c: the first v3 scan over a genuine v2
//    baseline reports verified: 0, baselineUpgraded: 1 and certifies
//    nothing, and a v2 baseline over DRIFTED bytes still blocks adoption
//    (drift verdicts do not depend on the hash definition);
//  - adversarial probes: a v2 baseline row carrying a malformed/unknown
//    hash shape fails closed as drift, an unknown snapshot format is an
//    untrusted transition (never a match), one bad row indicts only its
//    own room, and an unreadable projection surfaces as an error rather
//    than a fabricated hash.
// T-L1c's failing-first full version is a later lane's (B7); this file
// carries the seam it waits on: the ranged digest + the v3 transition.

const tick = store => store.verifyRoomIntegrity({ yieldBetween: async () => {} });

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "project-room-integrity-v3-"));
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

function roomRow(store, roomId = "alpha") {
  return store.db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get(roomId);
}

function storedHash(store, roomId = "alpha") {
  return store.db.prepare("SELECT projection_hash AS hash FROM integrity_room_state WHERE room_id=?").get(roomId)?.hash;
}

function mutateSameLength(store) {
  const row = store.db.prepare("SELECT projection, LENGTH(projection) AS bytes FROM rooms WHERE id='alpha'").get();
  const tampered = row.projection.replace("Project Room Commons", "Project Room Commonz");
  assert.notEqual(tampered, row.projection);
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(tampered);
  assert.equal(store.db.prepare("SELECT LENGTH(projection) AS bytes FROM rooms WHERE id='alpha'").get().bytes, row.bytes);
  return row.projection;
}

// The v2 snapshot digest composition (store-internal at base): a sha256
// over the per-room hashes in id order, each framed id \0 hash \n.
function v2SnapshotDigest(store) {
  const digest = createHash("sha256");
  for (const row of store.db.prepare("SELECT room_id AS id, projection_hash AS hash FROM integrity_room_state ORDER BY room_id").all()) {
    digest.update(row.id).update("\0").update(row.hash).update("\n");
  }
  return digest.digest("hex");
}

// Rewrite the store's baseline exactly as the pre-v3 code left it: every
// remembered per-room hash recomputed under the v2 definition, and the
// snapshot text in the v2 shape carrying the v2 composition digest.
function downgradeToV2Baseline(store) {
  const update = store.db.prepare("UPDATE integrity_room_state SET projection_hash=? WHERE room_id=?");
  for (const row of store.db.prepare("SELECT id FROM rooms ORDER BY id").all()) {
    const room = roomRow(store, row.id);
    update.run(projectionContentHashV2(store.db, row.id, room.sequence, room.projection), row.id);
  }
  const checksum = store.integrityChecksum();
  const text = ["v2", checksum.rooms, checksum.sequences, checksum.projectionBytes,
    checksum.invitations, checksum.journalEntries, checksum.journalSequences, v2SnapshotDigest(store)].join(":");
  store.db.prepare("UPDATE integrity_snapshot SET checksum=? WHERE id=1").run(text);
  return text;
}

test("v3 composition: the room hash is a digest over (room id, sequence, projection digest, range digests in order)", async () => {
  const fixture = openStore();
  try {
    const { store } = fixture;
    const key = store.issueAccessKey("alpha", "owner");
    store.command(key, "alpha", { id: "seed-1", type: "message.posted", data: { body: "seed" } });
    // Fixture shaping only (no verdict is read from this room): bulk-copy
    // the seed message row past one range boundary and restate the
    // projection in its canonical message-authority shape, so the scan
    // streams > CONTENT_HASH_RANGE_ROWS rows.
    const seed = store.db.prepare("SELECT * FROM messages WHERE room_id='alpha'").get();
    const columns = Object.keys(seed);
    const insert = store.db.prepare(`INSERT INTO messages (${columns.join(",")}) VALUES (${columns.map(column => "@" + column).join(",")})`);
    store.transaction(() => {
      for (let i = 0; i < CONTENT_HASH_RANGE_ROWS + 5; i++) insert.run({ ...seed, message_id: `bulk-${i}`, seq: 10000 + i });
    });
    const row = roomRow(store);
    const state = JSON.parse(row.projection);
    state.messageAuthority = { version: 1, count: CONTENT_HASH_RANGE_ROWS + 6 };
    delete state.messages;
    const projection = JSON.stringify(state);
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(projection);

    const proof = servingContentProof(store.db, "alpha", row.sequence, projection);
    assert.equal(proof.rangeDigests.length, 2, "206 streamed rows form two ranges at the 200-row boundary");
    assert.equal(proof.hash, composeContentHash("alpha", row.sequence, projectionDigest(projection), proof.rangeDigests),
      "the served hash is exactly the documented composition of its banked range digests");
    assert.equal(proof.hash, projectionContentHash(store.db, "alpha", row.sequence, projection));
    assert.notEqual(proof.hash, composeContentHash("alpha", row.sequence, projectionDigest(projection), [...proof.rangeDigests].reverse()),
      "range order is bound into the composition");
    assert.notEqual(proof.hash, composeContentHash("alpha", row.sequence + 1, projectionDigest(projection), proof.rangeDigests),
      "the sequence is bound into the composition");
    assert.notEqual(proof.hash, projectionContentHashV2(store.db, "alpha", row.sequence, projection),
      "the v3 definition differs from the v2 stream it replaces");
    // Grouping sensitivity at the pure seam: the same rows split at a
    // different boundary are a different composition input.
    assert.notEqual(contentRangeDigest(["a", "b"]), contentRangeDigest(["a"]), "a range digest covers exactly its rows");
  } finally { fixture.close(); }
});

test("T-L1c drift half (non-regression pin): in-place byte drift at an unchanged sequence is detected, recorded, never adopted", async () => {
  const fixture = openStore();
  try {
    const { store } = fixture;
    await tick(store);
    const baseline = snapshotText(store);
    assert.match(baseline, /^v3:/);
    const baselineHash = storedHash(store);
    mutateSameLength(store);
    const first = await tick(store);
    assert.equal(first.verified, 0);
    assert.equal(first.matched, 0);
    assert.equal(first.contentDrift, 1);
    const failures = store.integrityFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].step, "projection_content");
    assert.equal(failures[0].recordId, "alpha");
    assert.equal(snapshotText(store), baseline, "the drifted bytes are not adopted as the v3 baseline");
    assert.equal(storedHash(store), baselineHash, "the remembered per-room hash is untouched by drift");
    const second = await tick(store);
    assert.equal(second.verified, 0);
    assert.equal(second.matched, 0, "the drifted room is never skipped as matched");
    assert.equal(snapshotText(store), baseline);
  } finally { fixture.close(); }
});

test("T-L1c transition half: the first v3 scan over a v2 baseline reports verified: 0, baselineUpgraded: 1 and certifies nothing", async () => {
  const fixture = openStore();
  try {
    const { store } = fixture;
    await tick(store);
    await tick(store);
    const v2Text = downgradeToV2Baseline(store);
    assert.match(v2Text, /^v2:/);
    assert.equal(storedHash(store), projectionContentHashV2(store.db, "alpha", roomRow(store).sequence, roomRow(store).projection),
      "the fixture baseline really is v2-definition");
    const transition = await tick(store);
    assert.equal(transition.verified, 0, "the transition scan certifies nothing against the previous definition");
    assert.equal(transition.matched, 0, "a v2 baseline never matches under v3");
    assert.equal(transition.baselineUpgraded, 1, "the v3 baseline adoption is explicit, not silent");
    assert.equal(transition.contentDrift, undefined, "an untouched room is not indicted by the definition change itself");
    assert.deepEqual(store.integrityFailures(), []);
    assert.match(snapshotText(store), /^v3:/);
    assert.equal(snapshotText(store), store.integrityChecksum().text, "the adopted baseline is the v3 checksum");
    assert.equal(storedHash(store), projectionContentHash(store.db, "alpha", roomRow(store).sequence, roomRow(store).projection),
      "the remembered per-room hash is v3-definition after adoption");
    const quiet = await tick(store);
    assert.equal(quiet.matched, 1, "the adopted v3 baseline is authoritative from the next scan");
  } finally { fixture.close(); }
});

test("T-L1c transition with drift: a v2 baseline over drifted bytes blocks adoption, and repair lets the transition complete", async () => {
  const fixture = openStore();
  try {
    const { store } = fixture;
    await tick(store);
    await tick(store);
    const v2Text = downgradeToV2Baseline(store);
    const v2Hash = storedHash(store);
    const original = mutateSameLength(store);
    const blocked = await tick(store);
    assert.equal(blocked.verified, 0);
    assert.equal(blocked.contentDrift, 1, "drift is judged against the v2 baseline during the transition — the verdict does not depend on the hash definition");
    assert.equal(blocked.baselineUpgraded, undefined, "drifted bytes are never adopted, at any definition");
    assert.equal(snapshotText(store), v2Text, "the snapshot stays at the v2 baseline while drift stands");
    assert.equal(storedHash(store), v2Hash);
    assert.equal(store.integrityFailures().filter(row => row.step === "projection_content" && row.recordId === "alpha").length, 1);
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(original);
    const transition = await tick(store);
    assert.equal(transition.verified, 0, "the completing scan is still the transition scan: it certifies nothing");
    assert.equal(transition.baselineUpgraded, 1, "once the bytes return to the v2 baseline, the v3 adoption proceeds explicitly");
    assert.deepEqual(store.integrityFailures(), [], "repair against the old baseline retires the drift record");
    assert.match(snapshotText(store), /^v3:/);
  } finally { fixture.close(); }
});

test("adversarial: a v2 baseline row with a malformed hash shape fails closed as drift and is never adopted", async () => {
  const fixture = openStore();
  try {
    const { store } = fixture;
    await tick(store);
    await tick(store);
    const v2Text = downgradeToV2Baseline(store);
    // The designed probe case: a remembered hash that is no definition's
    // output — an unknown shape, neither v2 nor v3.
    store.db.prepare("UPDATE integrity_room_state SET projection_hash='not-a-hash' WHERE room_id='alpha'").run();
    const scan = await tick(store);
    assert.equal(scan.verified, 0, "an unknown hash shape cannot certify");
    assert.equal(scan.matched, 0);
    assert.equal(scan.baselineUpgraded, undefined, "an unknown hash shape is not an explicit upgrade — nothing is adopted");
    assert.equal(scan.contentDrift, 1, "the malformed baseline reads as drift against the room's bytes, not as a match");
    assert.equal(snapshotText(store), v2Text, "the snapshot does not advance over an unknown baseline shape");
    assert.equal(storedHash(store), "not-a-hash", "the malformed value is left standing for an authorised repair, not overwritten");
    assert.equal(store.integrityFailures().filter(row => row.step === "projection_content" && row.recordId === "alpha").length, 1);
  } finally { fixture.close(); }
});

test("adversarial: an unknown snapshot format is an untrusted transition, never a match", async () => {
  const fixture = openStore();
  try {
    const { store } = fixture;
    await tick(store);
    store.db.prepare("UPDATE integrity_snapshot SET checksum='v9:1:2:3:4:5:6:deadbeef' WHERE id=1").run();
    const scan = await tick(store);
    assert.equal(scan.verified, 0, "an unknown format certifies nothing");
    assert.equal(scan.matched, 0, "an unknown format never matches");
    assert.equal(scan.baselineUpgraded, 1, "recovery is the explicit, uncertified adoption — the only path off an unknown baseline");
    assert.match(snapshotText(store), /^v3:/);
    assert.deepEqual(store.integrityFailures(), []);
  } finally { fixture.close(); }
});

test("adversarial: one bad row indicts only its own room", async () => {
  const fixture = openStore();
  try {
    const { store } = fixture;
    store.initialize(initialRoom("beta"));
    await tick(store);
    await tick(store);
    const v2Text = downgradeToV2Baseline(store);
    store.db.prepare("UPDATE integrity_room_state SET projection_hash='garbage' WHERE room_id='beta'").run();
    const scan = await tick(store);
    assert.equal(scan.verified, 0);
    assert.equal(scan.baselineUpgraded, undefined, "the bad row blocks the store-wide adoption");
    assert.equal(snapshotText(store), v2Text);
    const failures = store.integrityFailures().filter(row => row.step === "projection_content");
    assert.deepEqual(failures.map(row => row.recordId), ["beta"], "alpha carries no failure from beta's bad row");
  } finally { fixture.close(); }
});

test("adversarial: an unreadable projection surfaces as an error, never a fabricated hash", async () => {
  const fixture = openStore();
  try {
    const { store } = fixture;
    const row = roomRow(store);
    assert.throws(() => projectionContentHash(store.db, "alpha", row.sequence, "{not json"), SyntaxError,
      "a projection that cannot be read throws instead of hashing whatever was salvaged");
    assert.throws(() => servingContentProof(store.db, "alpha", row.sequence, "{not json"), SyntaxError);
  } finally { fixture.close(); }
});
