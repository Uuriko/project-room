import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ensureStorageHomeIfEnabled } from "../server/room-shard-flag.mjs";
import { resolveRoomHome } from "../server/room-shard-route.mjs";

const ON = { ROOM_PER_ROOM_OBJECTS: "1" };

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-shard-route-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  return store;
}

test("routing stays on invite-only-pilot until the flag is on and storage_home is room", t => {
  const store = openStore(t);
  const pilot = { home: "pilot", binding: "ROOM", name: "invite-only-pilot" };
  assert.deepEqual(resolveRoomHome({}, "commons", store.db), pilot);
  assert.deepEqual(resolveRoomHome(ON, "commons", store.db), pilot);
  assert.deepEqual(resolveRoomHome(ON, "commons"), pilot);
  ensureStorageHomeIfEnabled(ON, store.db);
  store.db.prepare("UPDATE rooms SET storage_home = 'room' WHERE id = 'commons'").run();
  assert.deepEqual(resolveRoomHome({}, "commons", store.db), pilot);
  assert.deepEqual(resolveRoomHome({ ROOM_PER_ROOM_OBJECTS: "0" }, "commons", store.db), pilot);
  assert.deepEqual(resolveRoomHome(ON, "invite-only-pilot", store.db), pilot);
  assert.deepEqual(resolveRoomHome(ON, "commons", store.db), { home: "room", binding: "ROOM_SHARD", name: "commons" });
});

test("wrangler adds RoomShard without turning the flag on or retagging ProjectRoom", () => {
  const release = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(release.migrations[0], { tag: "room-sqlite-v1", new_sqlite_classes: ["ProjectRoom"] });
  assert.deepEqual(release.migrations[1], { tag: "room-shard-v1", new_sqlite_classes: ["RoomShard"] });
  assert.equal(release.durable_objects.bindings[0].name, "ROOM");
  assert.equal(release.durable_objects.bindings[0].class_name, "ProjectRoom");
  assert.equal(release.durable_objects.bindings[1].name, "ROOM_SHARD");
  assert.equal(release.durable_objects.bindings[1].class_name, "RoomShard");
  assert.equal(release.durable_objects.bindings[1].script_name, "project-room");
  const production = release.env.production;
  assert.equal(production.durable_objects.bindings[1].name, "ROOM_SHARD");
  assert.equal(production.durable_objects.bindings[1].class_name, "RoomShard");
  assert.equal(production.durable_objects.bindings[1].script_name, undefined);
  assert.deepEqual(production.triggers.crons, ["*/30 * * * *"]);
  const staging = release.env.staging;
  assert.equal(staging.durable_objects.bindings[0].class_name, "ProjectRoom");
  assert.equal(staging.durable_objects.bindings[0].script_name, undefined);
  assert.equal(staging.durable_objects.bindings[1].class_name, "RoomShard");
  assert.equal(staging.durable_objects.bindings[1].script_name, undefined);
  assert.deepEqual(staging.migrations[0], { tag: "room-sqlite-v1", new_sqlite_classes: ["ProjectRoom"] });
  assert.deepEqual(staging.migrations[1], { tag: "room-shard-v1", new_sqlite_classes: ["RoomShard"] });
  assert.deepEqual(staging.triggers.crons, []);
  for (const vars of [release.vars, production.vars, staging.vars]) {
    assert.equal(vars.ROOM_PER_ROOM_OBJECTS, undefined);
  }
});
