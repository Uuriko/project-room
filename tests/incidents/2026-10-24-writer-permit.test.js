// 2026-10-24: room_writer_permit held one row at the writer version (42,
// "write in progress"). Every outermost transaction, including the Durable
// Object cold start, threw "Database writer fence requires operator
// reconciliation". PR #4878 resets that row to 0 before the check. This
// test stays skipped until that self-heal is in cloudflare/storage.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DurableDatabase, durableStorage } from "../../cloudflare/storage.mjs";
import { STORE_SCHEMA_VERSION } from "../../server/writer-fence.mjs";
import { DoStorageEmulator } from "../helpers/do-storage-emulator.mjs";

const storageSource = readFileSync(new URL("../../cloudflare/storage.mjs", import.meta.url), "utf8");
const selfHealLanded = storageSource.includes("room.writer_permit_stale_reset");

// Same DDL cloudflare/storage.mjs installs. A drift here fails verifyPermit
// on the schema text, which is a different fault from a stuck value.
const permitSchema = version =>
  `CREATE TABLE room_writer_permit (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version IN (0,${version})))`;

function stuckPermitDatabase() {
  const storage = new DoStorageEmulator();
  storage.sql.exec("CREATE TABLE room_runtime_version (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL)");
  storage.sql.exec(`INSERT INTO room_runtime_version VALUES (1, ${STORE_SCHEMA_VERSION})`);
  storage.sql.exec(permitSchema(STORE_SCHEMA_VERSION));
  storage.sql.exec(`INSERT INTO room_writer_permit VALUES (1, ${STORE_SCHEMA_VERSION})`);
  return { storage, db: new DurableDatabase(storage) };
}

test("2026-10-24: a writer permit stuck at 42 is cleared on the next cold-start transaction", {
  skip: selfHealLanded ? false : "enable when #4878 lands",
}, () => {
  assert.equal(STORE_SCHEMA_VERSION, 42);
  const { storage, db } = stuckPermitDatabase();
  const lines = [];
  const original = console.error;
  console.error = line => { lines.push(String(line)); };
  try {
    assert.equal(durableStorage.transaction(db, () => true), true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM room_writer_permit").get().n, 1);
    assert.equal(db.prepare("SELECT version FROM room_writer_permit WHERE singleton=1").get().version, 0);
  } finally {
    console.error = original;
    storage.close();
  }
  const events = lines.flatMap(line => {
    try { return [JSON.parse(line)]; }
    catch { return []; }
  });
  assert.ok(events.some(event => event.event === "room.writer_permit_stale_reset" && event.version === 42));
});
