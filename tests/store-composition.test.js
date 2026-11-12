import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { measureStoreComposition } from "../server/jobs.mjs";

function storeWith(sql) {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  return { db };
}

test("store composition reports flat byte gauges and skips tables a store lacks", () => {
  const store = storeWith(`
    CREATE TABLE rooms (id TEXT PRIMARY KEY, projection TEXT);
    INSERT INTO rooms VALUES ('a', 'xxxx'), ('b', 'yy');
    CREATE TABLE room_backup_export_parts (part_index INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
    INSERT INTO room_backup_export_parts VALUES (0, zeroblob(100));`);
  const value = measureStoreComposition(store, 10 ** 15);
  assert.equal(value.bytesRoomProjection, 6);
  assert.equal(value.bytesBackupStaging, 100);
  assert.equal("bytesMessageBodies" in value, false, "a missing table leaves its gauge out");
  for (const n of Object.values(value)) assert.ok(Number.isSafeInteger(n));
});

test("store composition rereads the store at most once per refresh window", () => {
  const store = storeWith("CREATE TABLE rooms (id TEXT PRIMARY KEY, projection TEXT); INSERT INTO rooms VALUES ('a', 'xx');");
  const base = 2 * 10 ** 15;
  assert.equal(measureStoreComposition(store, base).bytesRoomProjection, 2);
  store.db.exec("INSERT INTO rooms VALUES ('b', 'zzzz')");
  assert.equal(measureStoreComposition(store, base + 1000).bytesRoomProjection, 2, "cached inside the window");
  assert.equal(measureStoreComposition(store, base + 7 * 60 * 60 * 1000).bytesRoomProjection, 6, "refreshed after the window");
});
