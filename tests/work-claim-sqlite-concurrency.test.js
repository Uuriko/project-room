// WAVE-2000 guild 20 (lock+fence+concurrency): fail-first regression tests for
// the work-claim-sqlite read-modify-write hazards.
//
// server/work-claim-sqlite.mjs delete() waives the deleted id from every
// dependent's dependsOn, and configure() merges JS-side before upserting.
// Both are multi-statement read-modify-writes; without an atomic wrapper two
// concurrent writers on separate connections can interleave and silently
// lose a waiver / a config key (demonstrated in direct/stress-registry-
// configure.mjs). The fix wraps both in the registry's transaction(), which
// is nesting-safe (store.transaction runs fn directly when db.isTransaction).
//
// These tests are deterministic: they assert delete()/configure() actually
// route through the provided transaction wrapper (fail-first: they fail on
// the unwrapped code), plus functional and nesting-safety pins.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";

const setup = ({ transaction = fn => fn() } = {}) => {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const calls = [];
  const reg = createDurableWorkClaimRegistry(db, {
    transaction: fn => { calls.push("tx"); return transaction(fn); },
  });
  return { db, reg, calls };
};

const item = (id, dependsOn = []) => ({ id, title: id, state: "unclaimed", owner: null, history: [], dependsOn });

test("delete() runs the dependent-waiving read-modify-write inside transaction()", () => {
  const { reg, calls } = setup();
  reg.set("r", item("X"));
  reg.set("r", item("D", ["X"]));
  calls.length = 0;
  reg.delete("r", "X");
  assert.ok(calls.includes("tx"), "delete() must route through transaction()");
  assert.equal(reg.get("r", "X"), null);
  assert.deepEqual(reg.get("r", "D").dependsOn, []);
});

test("configure() runs the read-merge-upsert inside transaction()", () => {
  const { reg, calls } = setup();
  reg.configure("r", { maxOpenClaims: 50 });
  calls.length = 0;
  const cfg = reg.configure("r", { defaultLeaseHours: 12 });
  assert.ok(calls.includes("tx"), "configure() must route through transaction()");
  assert.equal(cfg.maxOpenClaims, 50);
  assert.equal(cfg.defaultLeaseHours, 12);
});

test("delete() inside an outer transaction does not double-begin (nesting-safe)", () => {
  // Simulates store.transaction: nested calls run directly when a write
  // transaction is already held.
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  let depth = 0;
  const transaction = fn => {
    if (depth > 0) return fn();
    depth++;
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; }
    catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
    finally { depth--; }
  };
  const reg = createDurableWorkClaimRegistry(db, { transaction });
  reg.set("r", item("X"));
  reg.set("r", item("D", ["X"]));
  transaction(() => reg.delete("r", "X")); // caller already holds the write tx
  assert.equal(reg.get("r", "X"), null);
  assert.deepEqual(reg.get("r", "D").dependsOn, []);
  db.close();
});

test("delete() rolls back the waiver when the delete throws", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const transaction = fn => {
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; }
    catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  };
  const reg = createDurableWorkClaimRegistry(db, { transaction });
  reg.set("r", item("X"));
  reg.set("r", item("D", ["X"]));
  // Poison the DELETE so the waiving upsert must roll back with it.
  const origPrepare = db.prepare.bind(db);
  db.prepare = sql => String(sql).startsWith("DELETE FROM work_claims")
    ? { run: () => { throw new Error("boom"); } }
    : origPrepare(sql);
  assert.throws(() => reg.delete("r", "X"), /boom/);
  db.prepare = origPrepare;
  assert.deepEqual(reg.get("r", "D").dependsOn, ["X"], "waiver rolled back with the failed delete");
  db.close();
});
