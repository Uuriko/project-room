// The worker's store-growth dbBytes gauge read 0 in production because the
// Durable Object runtime refuses PRAGMA page_count. These tests drive the
// real DurableDatabase adapter over a storage double whose SQL surface
// refuses pragmas, as the platform does, and exposes databaseSize.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DurableDatabase } from "../cloudflare/storage.mjs";
import { STORE_GROWTH_LIMITS, measureStoreGrowth, storeGrowthBreach } from "../server/jobs.mjs";

function durableStorage(databaseSize) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT NOT NULL)");
  db.prepare("INSERT INTO rooms VALUES (?, ?, ?)").run("r1", 7, "x".repeat(1000));
  const sql = {
    exec(query, ...args) {
      if (/^\s*PRAGMA/i.test(query)) throw new Error("not authorized: SQLITE_AUTH");
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows, one: () => rows[0], rowsRead: rows.length };
    }
  };
  if (databaseSize !== undefined) Object.defineProperty(sql, "databaseSize", { get: () => databaseSize });
  return { sql };
}

test("failing first: without databaseSize the worker gauge reads 0 (the production symptom)", () => {
  const gauges = measureStoreGrowth({ db: new DurableDatabase(durableStorage(undefined)) });
  assert.equal(gauges.dbBytes, 0);
  assert.equal(gauges.rooms, 1);
  assert.equal(gauges.maxProjectionBytes, 1000);
});

test("the worker gauge reads the platform databaseSize", () => {
  const gauges = measureStoreGrowth({ db: new DurableDatabase(durableStorage(123_456_789)) });
  assert.equal(gauges.dbBytes, 123_456_789);
  assert.equal(storeGrowthBreach(gauges, STORE_GROWTH_LIMITS), null);
});

test("a worker database past the 8 GB line is a named dbBytes breach", () => {
  const gauges = measureStoreGrowth({ db: new DurableDatabase(durableStorage(STORE_GROWTH_LIMITS.dbBytes + 1)) });
  assert.equal(storeGrowthBreach(gauges, STORE_GROWTH_LIMITS), "dbBytes");
});

test("a non-numeric databaseSize falls back instead of reporting NaN", () => {
  const adapter = new DurableDatabase(durableStorage("garbage"));
  assert.ok(Number.isNaN(adapter.databaseSize()));
  assert.equal(measureStoreGrowth({ db: adapter }).dbBytes, 0);
});
