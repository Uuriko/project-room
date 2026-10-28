import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { REPLAY_SKIPPED_TABLES } from "../server/room-export.mjs";
import { assertShardClassification, roomKeyColumn, tableHome } from "../server/room-shard.mjs";
import { ROOM_TABLE_KEYS } from "../server/room-shard-tables.mjs";

function liveNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
}

test("a fresh store's tables are classified room or directory", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-shard-tables-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const names = liveNames(store.db).filter(name => !name.startsWith("sqlite_"));
  assertShardClassification(names);
  const homes = new Map(names.map(name => [name, tableHome(name)]));
  assert.equal(homes.get("events"), "room");
  assert.equal(homes.get("commands"), "room");
  assert.equal(homes.get("messages"), "room");
  assert.equal(homes.get("rooms"), "room");
  assert.equal(homes.get("accounts"), "directory");
  assert.equal(homes.get("credentials"), "directory");
  assert.equal(homes.get("account_session_slots"), "directory");
  for (const [table, column] of Object.entries(ROOM_TABLE_KEYS)) {
    const columns = store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    assert.ok(columns.includes(column), `${table} keeps its room key ${column}`);
    assert.equal(roomKeyColumn(table), column);
  }
  for (const name of REPLAY_SKIPPED_TABLES) {
    assert.equal(tableHome(name), "skipped");
    assert.equal(homes.has(name), false);
  }
});

test("a table the classification does not name is refused", () => {
  assert.throws(() => tableHome("not_a_room_table"), /Unclassified SQLite table not_a_room_table/);
  assert.throws(() => assertShardClassification(["events"]), /directory table accounts is not in the live schema/);
});
