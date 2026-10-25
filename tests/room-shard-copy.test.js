import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { compareRoomHomes, copyRoomRows } from "../server/room-shard-copy.mjs";

function openPair(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-shard-copy-"));
  const pilot = new RoomStore(join(directory, "pilot.sqlite"));
  const shard = new RoomStore(join(directory, "shard.sqlite"));
  t.after(() => {
    pilot.close();
    shard.close();
    rmSync(directory, { recursive: true, force: true });
  });
  pilot.initialize(initialRoom());
  const token = pilot.issueAccessKey("commons", "owner");
  pilot.command(token, "commons", { id: randomUUID(), type: "message.posted", data: { body: "hello shard" } });
  pilot.createAccount("joiner", "repro");
  return { pilot, shard };
}

test("copy moves one room's log and leaves directory rows on the pilot", t => {
  const { pilot, shard } = openPair(t);
  const before = compareRoomHomes(pilot, shard, "commons");
  assert.equal(before.same, false);
  assert.ok(before.pilot.events > 0);
  assert.ok(before.pilot.messages > 0);
  assert.ok(before.pilot.projectionBytes > 0);
  copyRoomRows(pilot, shard, "commons");
  const copied = compareRoomHomes(pilot, shard, "commons");
  assert.equal(copied.same, true);
  assert.equal(copied.shard.events, copied.pilot.events);
  assert.equal(shard.db.prepare("SELECT count(*) AS n FROM accounts").get().n, 0);
  assert.ok(pilot.db.prepare("SELECT count(*) AS n FROM accounts").get().n > 0);
  assert.equal(shard.db.prepare("SELECT count(*) AS n FROM credentials").get().n, 0);
  const again = copyRoomRows(pilot, shard, "commons");
  assert.equal(again.tables > 0, true);
  assert.equal(compareRoomHomes(pilot, shard, "commons").same, true);
  assert.equal(shard.db.prepare("SELECT count(*) AS n FROM events WHERE room_id = 'commons'").get().n, copied.shard.events);
});

test("a changed shard row fails the compare until the room is copied again", t => {
  const { pilot, shard } = openPair(t);
  copyRoomRows(pilot, shard, "commons");
  shard.db.prepare("UPDATE rooms SET projection = projection || ' ' WHERE id = 'commons'").run();
  const drifted = compareRoomHomes(pilot, shard, "commons");
  assert.equal(drifted.same, false);
  assert.notEqual(drifted.shard.projectionBytes, drifted.pilot.projectionBytes);
  copyRoomRows(pilot, shard, "commons");
  assert.equal(compareRoomHomes(pilot, shard, "commons").same, true);
});

test("copy refuses the directory object name", t => {
  const { pilot, shard } = openPair(t);
  assert.throws(() => copyRoomRows(pilot, shard, "invite-only-pilot"), /Room id is required/);
  assert.equal(shard.db.prepare("SELECT count(*) AS n FROM events").get().n, 0);
});
