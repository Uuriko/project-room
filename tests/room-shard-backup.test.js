import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonText } from "../server/room-export.mjs";
import { exportRoomNdjson, restoreRoomNdjson, roomHomeDigest } from "../server/room-shard-copy.mjs";

function openPilot(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-shard-backup-"));
  const pilot = new RoomStore(join(directory, "pilot.sqlite"));
  t.after(() => {
    pilot.close();
    rmSync(directory, { recursive: true, force: true });
  });
  pilot.initialize(initialRoom());
  const token = pilot.issueAccessKey("commons", "owner");
  pilot.command(token, "commons", { id: randomUUID(), type: "message.posted", data: { body: "backed up" } });
  pilot.createAccount("joiner", "repro");
  return { directory, pilot };
}

function openRestored(path) {
  return new DatabaseSync(path, { readOnly: true });
}

test("a room slice round-trips and a directory or unknown table still fails restore", t => {
  const { directory, pilot } = openPilot(t);
  const source = roomHomeDigest(pilot, "commons");
  assert.ok(source.events > 0);
  const ndjson = exportRoomNdjson(pilot, "commons");
  const restoredPath = join(directory, "room", "room.sqlite");
  const restored = restoreRoomNdjson(ndjson, restoredPath);
  assert.equal(restored.verified, true);
  assert.equal(restored.events, source.events);
  assert.equal(restored.audit.ok, true);
  const db = openRestored(restoredPath);
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS n FROM accounts").get().n, 0);
  assert.ok(pilot.db.prepare("SELECT count(*) AS n FROM accounts").get().n > 0);
  assert.deepEqual(roomHomeDigest(db, "commons"), source);

  const lines = ndjson.trimEnd().split("\n");
  const trailer = lines.pop();
  lines.push(JSON.stringify({ table: "not_a_room_table", row: { id: "x" } }));
  lines.push(trailer);
  assert.throws(() => restoreRoomNdjson(`${lines.join("\n")}\n`, join(directory, "unknown", "room.sqlite")), /Export names a table this store does not have/);
  assert.throws(() => restoreRoomNdjson(exportNdjsonText(pilot.db), join(directory, "full", "room.sqlite")), /Export names a table this store does not have/);
});
