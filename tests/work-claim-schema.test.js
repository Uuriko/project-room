// Production startup is the boundary: incompatible existing tables must not
// be silently repaired, while an older database with neither table may migrate.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-claim-schema-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  const platform = store.storagePlatform;
  store.close();
  return { filename, platform };
}
function inspect(filename, fn) {
  const db = new DatabaseSync(filename);
  try { return fn(db); } finally { db.close(); }
}
const schema = db => db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('work_claims','work_claim_config') ORDER BY name").all().map(row => ({ ...row }));
const allSchema = db => db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all().map(row => ({ ...row }));
function removeNewerClaimProfile(db) {
  // Model a genuinely older database, not damaged modern public tasks. All
  // public sidecars are empty here; no published scope or receipt is discarded.
  for (const table of ["public_work_tasks", "public_work_requests", "public_work_receipts"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.equal(db.prepare("SELECT enabled FROM public_work_claim_writer_permit").get().enabled, 0);
  db.exec(`DROP TABLE public_work_receipts; DROP TABLE public_work_requests;
    DROP TABLE public_work_tasks; DROP TABLE public_work_claim_writer_permit;
    DROP TABLE work_claims; DROP TABLE work_claim_config; DROP TABLE work_claim_idempotency;`);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name GLOB 'public_claim_guard_*'").get().n, 0);
  return allSchema(db);
}

for (const readOnly of [false, true]) {
  for (const [label, damage] of [
    ["malformed", "DROP TABLE work_claims; CREATE TABLE work_claims (claim_id TEXT PRIMARY KEY)"],
    ["claims table absent", "DROP TABLE work_claims"],
    ["config table absent", "DROP TABLE work_claim_config"],
  ]) {
    test(`RoomStore refuses ${label} claim schema on ${readOnly ? "read-only" : "write"} startup without repair`, t => {
      const { filename } = fixture(t);
      const before = inspect(filename, db => { db.exec(damage); return allSchema(db); });
      assert.throws(() => { const unexpected = new RoomStore(filename, { readOnly }); unexpected.close(); }, /Work-claim schema requires operator reconciliation/);
      assert.deepEqual(inspect(filename, allSchema), before, "refused startup must leave the existing schema unchanged");
    });
  }
}

test("read-only startup permits both old claim tables absent and does not create them", t => {
  const { filename } = fixture(t);
  const before = inspect(filename, removeNewerClaimProfile);
  const store = new RoomStore(filename, { readOnly: true });
  try {
    assert.equal(store.workClaims.verifySchema({ allowAbsent: true }), false);
    assert.deepEqual(schema(store.db), []);
  } finally { store.close(); }
  assert.deepEqual(inspect(filename, allSchema), before);
});

test("write startup creates both claim tables atomically and failed commit leaves neither", t => {
  const { filename, platform } = fixture(t);
  const before = inspect(filename, removeNewerClaimProfile);
  let observedBoth = false;
  const storagePlatform = { ...platform, transaction(db, fn, readOnly) {
    const outermost = !db.isTransaction;
    return platform.transaction(db, () => {
      const value = fn();
      if (!readOnly && outermost) {
        assert.deepEqual(schema(db).map(row => row.name), ["work_claim_config", "work_claims"]);
        observedBoth = true;
        throw new Error("fixture refuses startup commit");
      }
      return value;
    }, readOnly);
  } };
  assert.throws(() => new RoomStore(filename, { storagePlatform }), /fixture refuses startup commit/);
  assert.equal(observedBoth, true);
  assert.deepEqual(inspect(filename, allSchema), before, "both additions roll back together");
  const reopened = new RoomStore(filename);
  try {
    assert.equal(reopened.workClaims.verifySchema(), true);
    assert.deepEqual(schema(reopened.db).map(row => row.name), ["work_claim_config", "work_claims"]);
    reopened.workClaims.configure("fixture-room", { defaultLeaseHours: 4 });
    assert.equal(reopened.workClaims.configFor("fixture-room").defaultLeaseHours, 4);
  } finally { reopened.close(); }
});
