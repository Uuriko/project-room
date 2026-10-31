import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const ROOM_IDS = ["alpha", "beta", "gamma"];

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "project-room-integrity-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  for (const roomId of ROOM_IDS) store.initialize(initialRoom(roomId));
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function settle(store) {
  const first = await store.verifyRoomIntegrity({ yieldBetween: async () => {} });
  assert.equal(first.verified, 1);
  const quiet = await store.verifyRoomIntegrity({ yieldBetween: async () => {} });
  assert.equal(quiet.matched, 1);
  assert.equal(quiet.verified, 0);
  assert.equal(quiet.checked, 0);
  assert.equal(quiet.swept, 1);
  return quiet;
}

function snapshotText(store) {
  return store.db.prepare("SELECT checksum FROM integrity_snapshot WHERE id=1").get().checksum;
}

test("a sequence change updates the checksum without a full replay", async () => {
  const fixture = openStore();
  try {
    await settle(fixture.store);
    const key = fixture.store.issueAccessKey("beta", "owner");
    fixture.store.command(key, "beta", { id: "beta-note", type: "message.posted", data: { body: "One room moved." } });
    const tick = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(tick.verified, 0);
    assert.equal(tick.matched, 1);
    assert.equal(tick.checked, 1);
    assert.equal(tick.swept, 1);
    assert.equal(snapshotText(fixture.store), fixture.store.integrityChecksum().text);
    const state = fixture.store.db.prepare("SELECT sequence FROM integrity_room_state WHERE room_id='beta'").get();
    const room = fixture.store.db.prepare("SELECT sequence FROM rooms WHERE id='beta'").get();
    assert.equal(state.sequence, room.sequence);
  } finally { fixture.close(); }
});

test("projection bytes that change without a new event fail verification once the sweep reaches the room", async () => {
  const fixture = openStore();
  try {
    await settle(fixture.store);
    const baseline = snapshotText(fixture.store);
    const projection = fixture.store.db.prepare("SELECT projection FROM rooms WHERE id='gamma'").get().projection;
    const tampered = projection.replace("Project Room Commons", "Project Room Commons (edited)");
    assert.notEqual(tampered, projection);
    fixture.store.db.prepare("UPDATE rooms SET projection=? WHERE id='gamma'").run(tampered);
    const beforeSweep = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(beforeSweep.verified, 0);
    assert.equal(beforeSweep.checked, 0);
    assert.equal(fixture.store.db.prepare("SELECT projection FROM rooms WHERE id='gamma'").get().projection, tampered);
    assert.notEqual(snapshotText(fixture.store), fixture.store.integrityChecksum().text);
    // L05-C1: where the pre-cure sweep detection fell through to a full
    // pass that rebaselined the tampered bytes as verified:1, the content
    // digest now makes the sweep's finding a durable failure — the
    // snapshot keeps the clean baseline and later ticks keep failing.
    const swept = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(swept.verified, 0);
    assert.equal(swept.matched, 0);
    assert.equal(swept.contentDrift, 1);
    assert.equal(snapshotText(fixture.store), baseline);
    const failures = fixture.store.integrityFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].step, "projection_content");
    assert.equal(failures[0].recordId, "gamma");
    const again = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(again.verified, 0);
    assert.equal(again.matched, 0);
    assert.equal(snapshotText(fixture.store), baseline);
  } finally { fixture.close(); }
});

test("a room added after the snapshot is fully checked", async () => {
  const fixture = openStore();
  try {
    await settle(fixture.store);
    fixture.store.initialize(initialRoom("delta"));
    const tick = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(tick.verified, 1);
    assert.equal(snapshotText(fixture.store), fixture.store.integrityChecksum().text);
    const quiet = await fixture.store.verifyRoomIntegrity({ yieldBetween: async () => {} });
    assert.equal(quiet.matched, 1);
    assert.equal(quiet.verified, 0);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS n FROM integrity_room_state").get().n, 4);
  } finally { fixture.close(); }
});
