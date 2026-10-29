import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ensureStorageHomeIfEnabled, perRoomObjectsEnabled, readStorageHome, storageHomeColumnPresent } from "../server/room-shard-flag.mjs";

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-shard-flag-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  return store;
}

test("per-room objects stay off unless the env value is exactly 1", () => {
  assert.equal(perRoomObjectsEnabled(undefined), false);
  assert.equal(perRoomObjectsEnabled({}), false);
  assert.equal(perRoomObjectsEnabled({ ROOM_PER_ROOM_OBJECTS: "0" }), false);
  assert.equal(perRoomObjectsEnabled({ ROOM_PER_ROOM_OBJECTS: "true" }), false);
  assert.equal(perRoomObjectsEnabled({ ROOM_PER_ROOM_OBJECTS: "1 " }), false);
  assert.equal(perRoomObjectsEnabled({ ROOM_PER_ROOM_OBJECTS: "1" }), true);
});

test("opening a store does not add storage_home, and the flag gates the column", t => {
  const store = openStore(t);
  assert.equal(storageHomeColumnPresent(store.db), false);
  assert.equal(readStorageHome(store.db, "commons"), "pilot");
  assert.deepEqual(ensureStorageHomeIfEnabled({}, store.db), { changed: false });
  assert.deepEqual(ensureStorageHomeIfEnabled({ ROOM_PER_ROOM_OBJECTS: "0" }, store.db), { changed: false });
  assert.equal(storageHomeColumnPresent(store.db), false);
  assert.deepEqual(ensureStorageHomeIfEnabled({ ROOM_PER_ROOM_OBJECTS: "1" }, store.db), { changed: true });
  assert.equal(store.db.prepare("SELECT storage_home FROM rooms WHERE id = 'commons'").get().storage_home, "pilot");
  assert.deepEqual(ensureStorageHomeIfEnabled({ ROOM_PER_ROOM_OBJECTS: "1" }, store.db), { changed: false });
  store.db.prepare("UPDATE rooms SET storage_home = 'room' WHERE id = 'commons'").run();
  assert.equal(readStorageHome(store.db, "commons"), "room");
  store.db.prepare("UPDATE rooms SET storage_home = 'elsewhere' WHERE id = 'commons'").run();
  assert.equal(readStorageHome(store.db, "commons"), "pilot");
  assert.equal(readStorageHome(store.db, "missing-room"), "pilot");
});

test("checked-in worker config leaves per-room objects unset", () => {
  const release = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
  for (const vars of [release.vars, release.env.production.vars, release.env.staging.vars]) {
    assert.equal(vars.ROOM_PER_ROOM_OBJECTS, undefined);
  }
});
