import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { compareRoomHomes, mirrorRoomIfEnabled } from "../server/room-shard-copy.mjs";

const ON = { ROOM_PER_ROOM_OBJECTS: "1" };

function openPair(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-shard-mirror-"));
  const pilot = new RoomStore(join(directory, "pilot.sqlite"));
  const shard = new RoomStore(join(directory, "shard.sqlite"));
  t.after(() => {
    pilot.close();
    shard.close();
    rmSync(directory, { recursive: true, force: true });
  });
  pilot.initialize(initialRoom());
  const token = pilot.issueAccessKey("commons", "owner");
  const post = body => pilot.command(token, "commons", { id: randomUUID(), type: "message.posted", data: { body } });
  post("first");
  return { pilot, shard, post };
}

test("a pilot command does not reach the shard until mirror runs with the flag on", t => {
  const { pilot, shard, post } = openPair(t);
  assert.deepEqual(mirrorRoomIfEnabled({}, pilot, shard, "commons"), { mirrored: false });
  assert.equal(shard.db.prepare("SELECT count(*) AS n FROM events").get().n, 0);
  assert.deepEqual(mirrorRoomIfEnabled(ON, pilot, shard, "commons"), { mirrored: true });
  const copied = compareRoomHomes(pilot, shard, "commons");
  assert.equal(copied.same, true);
  post("second");
  const lagged = compareRoomHomes(pilot, shard, "commons");
  assert.equal(lagged.same, false);
  assert.equal(lagged.shard.events, copied.shard.events);
  assert.deepEqual(mirrorRoomIfEnabled({ ROOM_PER_ROOM_OBJECTS: "0" }, pilot, shard, "commons"), { mirrored: false });
  assert.equal(compareRoomHomes(pilot, shard, "commons").shard.events, copied.shard.events);
  assert.deepEqual(mirrorRoomIfEnabled(ON, pilot, shard, "commons"), { mirrored: true });
  const mirrored = compareRoomHomes(pilot, shard, "commons");
  assert.equal(mirrored.same, true);
  assert.ok(mirrored.shard.events > copied.shard.events);
});
