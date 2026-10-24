import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonText, replayNdjson } from "../server/room-export.mjs";
import { replayNdjsonInto, createBackupReplaySession } from "../server/restore-ndjson.mjs";
import { wakeListenerLeaseSchema, wakeRoomActivitySchema } from "../server/agent-heartbeats.mjs";
import { PROJECTION_SHAPE_UPGRADES_SCHEMA } from "../server/legacy-message-shape.mjs";
import { ensurePatrolSchema } from "../server/patrol.mjs";
import { ensureOAuthProviderSchema, OAUTH_PROVIDER_TABLES } from "../server/oauth-provider-store.mjs";
const tables = ["agent_wake_listener_leases", "agent_wake_signal_claims", "agent_wake_room_activity", "integrity_failures", "projection_shape_upgrades", "patrol_cursor", "patrol_claims", "patrol_messages", "patrol_findings", "patrol_blocks", ...OAUTH_PROVIDER_TABLES];
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "restore-lazy-"));
  const source = new RoomStore(join(dir, "source.sqlite"));
  t.after(() => { source.close(); rmSync(dir, { recursive: true, force: true }); });
  source.initialize(initialRoom());
  // Runtime feature initialization is independent of the restore initializer.
  source.db.exec(wakeListenerLeaseSchema + wakeRoomActivitySchema + PROJECTION_SHAPE_UPGRADES_SCHEMA);
  source.ensureIntegrityFailures(); ensurePatrolSchema(source); ensureOAuthProviderSchema(source.db);
  for (const table of tables) {
    const cols = source.db.prepare(`PRAGMA table_info("${table}")`).all();
    const values = cols.map(c => c.name === "target" ? "projection" : c.type === "INTEGER" ? 0 : `fixture-${c.name}`);
    source.db.prepare(`INSERT INTO "${table}" (${cols.map(c => `"${c.name}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...values);
  }
  return { dir, source };
}
for (const mode of ["file", "buffered", "streaming"]) {
  test(`${mode} does not initialize unrelated runtime schemas for an older backup`, t => {
    const dir = mkdtempSync(join(tmpdir(), "restore-old-schema-"));
    const source = new RoomStore(join(dir, "source.sqlite"));
    t.after(() => { source.close(); rmSync(dir, { recursive: true, force: true }); });
    source.initialize(initialRoom());
    const names = store => store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    const before = names(source), ndjson = exportNdjsonText(source.db), path = join(dir, "target.sqlite");
    let target;
    if (mode === "file") { replayNdjson(ndjson, path); target = new RoomStore(path, { readOnly: true }); }
    else {
      target = new RoomStore(path);
      if (mode === "buffered") replayNdjsonInto(ndjson, target);
      else { const session = createBackupReplaySession(target); session.writeText(ndjson); session.finish(); }
    }
    try { assert.deepEqual(names(target), before); }
    finally { target.close(); }
  });
  test(`${mode} restores populated runtime-only tables`, t => {
    const { dir, source } = fixture(t), ndjson = exportNdjsonText(source.db), path = join(dir, "target.sqlite");
    let target, receipt;
    if (mode === "file") { receipt = replayNdjson(ndjson, path); target = new RoomStore(path, { readOnly: true }); }
    else {
      target = new RoomStore(path);
      if (mode === "buffered") receipt = replayNdjsonInto(ndjson, target);
      else { const session = createBackupReplaySession(target); session.writeText(ndjson); receipt = session.finish(); }
    }
    try {
      assert.equal(receipt.verified, true); assert.equal(receipt.trailer, "verified");
      for (const table of tables) assert.deepEqual(target.db.prepare(`SELECT * FROM "${table}"`).all(), source.db.prepare(`SELECT * FROM "${table}"`).all(), table);
    } finally { target.close(); }
  });
  test(`${mode} refuses unknown tables`, t => {
    const { dir, source } = fixture(t);
    source.db.exec("CREATE TABLE untrusted_backup_table (value TEXT); INSERT INTO untrusted_backup_table VALUES ('do not accept')");
    const ndjson = exportNdjsonText(source.db), path = join(dir, "target.sqlite");
    if (mode === "file") assert.throws(() => replayNdjson(ndjson, path), /table this store does not have/);
    else {
      const target = new RoomStore(path);
      try {
        if (mode === "buffered") assert.throws(() => replayNdjsonInto(ndjson, target), /table this store does not have/);
        else { const session = createBackupReplaySession(target); try { assert.throws(() => { session.writeText(ndjson); session.finish(); }, /table this store does not have/); } finally { session.abort(); } }
        assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0);
      } finally { target.close(); }
    }
  });
}
