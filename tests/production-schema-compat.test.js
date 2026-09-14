import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { fenceDefinitions, STORE_SCHEMA_VERSION } from "../server/writer-fence.mjs";

// Production advanced on a separate lineage through schema 33 before rebuilt
// main introduced lifecycle at its own v28. Reproduce the deployed marker and
// writer fence instead of testing only fresh Miniflare storage.
test("rebuilt service opens deployed schema v33 and converges it without data loss", t => {
  const seed = createAcceptanceFixture();
  const filename = join(seed.directory, "room.sqlite");
  const projection = seed.store.room("commons").state;
  seed.store.close();
  const db = new DatabaseSync(filename);
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v34_*'").all()) db.exec(`DROP TRIGGER ${row.name}`);
  for (const { sql } of fenceDefinitions(33)) db.exec(sql);
  db.exec("PRAGMA user_version=33");
  db.close();

  const current = new RoomStore(filename);
  t.after(() => { current.close(); rmSync(seed.directory, { recursive: true, force: true }); });
  assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
  assert.equal(STORE_SCHEMA_VERSION, 34);
  assert.deepEqual(current.room("commons").state, projection);
  assert.ok(current.db.prepare("SELECT 1 FROM pragma_table_info('rooms') WHERE name='archived_at'").get());
  assert.ok(current.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_attachments'").get());
  current.createAccount("post-live-schema-upgrade");
  assert.equal(current.account("post-live-schema-upgrade").active, true);
});
