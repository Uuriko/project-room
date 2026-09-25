// Regression: BountyEscrow._ensure() must never write on read-only paths.
// Production incident 2026-09-22: _migrateColumns() ran an unconditional
// backfill UPDATE on every cold start, including pure read paths served by
// fresh Durable Object isolates. The read-only transaction guard threw
// "Cannot write inside a read-only Room transaction", so every first-touch
// read (balances, listBounties) 500'd with internal_error until the first
// bounty write warmed the isolate.
//
// This test runs the REAL production adapter (DurableDatabase +
// durableStorage from cloudflare/storage.mjs) over node:sqlite, so the
// read-only guard semantics are the ones production enforces — the
// permissive shims used by the other escrow tests mask this bug.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DurableDatabase, durableStorage } from "../cloudflare/storage.mjs";
import {
  BountyEscrow, bountyEscrowSchema, convergeBountyDeployedSchema,
} from "../server/bounty-escrow.mjs";

// Minimal DO-storage shim: only the surface DurableDatabase touches
// (storage.sql.exec + storage.transactionSync), backed by node:sqlite.
function makeStorage() {
  const raw = new DatabaseSync(":memory:");
  let mutating = 0; // INSERT/UPDATE/DELETE/ALTER/CREATE counter (test probe)
  const sql = {
    exec(sqlText, ...args) {
      const text = String(sqlText);
      const stripped = text.replace(/;+\s*$/, "");
      if (args.length === 0 && stripped.includes(";")) {
        raw.exec(text); // multi-statement schema script
        return { toArray: () => [], one: () => undefined };
      }
      if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|RENAME)\b/i.test(text)) mutating++;
      const stmt = raw.prepare(text);
      // node:sqlite has no StatementSync#reader (a better-sqlite3-ism):
      // classify by leading verb instead. RETURNING queries yield rows.
      const rows = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN|VALUES)\b/i.test(text) || /\bRETURNING\b/i.test(text)
        ? stmt.all(...args) : (stmt.run(...args), []);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  return { storage: { sql, transactionSync: fn => fn() }, counts: () => mutating, reset: () => { mutating = 0; } };
}

function makeStore(storage) {
  const db = new DurableDatabase(storage);
  durableStorage.registerWriter(db);
  return {
    db,
    now: () => Date.now(),
    readTransaction: fn => durableStorage.transaction(db, fn, true),
    writeTransaction: fn => durableStorage.transaction(db, fn, false),
    transaction: fn => durableStorage.transaction(db, fn, false),
  };
}

test("cold-isolate read performs zero writes and returns balances", () => {
  const { storage, counts, reset } = makeStorage();
  const store = makeStore(storage);
  // Boot-like convergence in a write-capable context (RoomStore constructor).
  store.transaction(() => {
    convergeBountyDeployedSchema(store.db);
    store.db.exec(bountyEscrowSchema);
  });
  reset();
  const escrow = new BountyEscrow(store, { allowLegacyStringLanes: true }); // cold isolate: _ready === false
  const before = counts();
  const result = escrow.balances("room1", "alice");
  assert.equal(counts(), before, "a read-only path must not issue any write");
  assert.equal(result.total, 0);
  assert.equal(result.payable, 0);
});

test("cold-isolate read still heals via a later write, then reads succeed", () => {
  const { storage } = makeStorage();
  const store = makeStore(storage);
  store.transaction(() => {
    convergeBountyDeployedSchema(store.db);
    store.db.exec(bountyEscrowSchema);
  });
  const escrow = new BountyEscrow(store, { allowLegacyStringLanes: true });
  escrow.balances("room1", "alice"); // cold read, must not throw
  const posted = escrow.postBounty("room1", {
    poster: "alice", title: "Fix the leak", criteria: "No more drips.",
    amount: 10, deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(posted.bounty.bountyId);
  const after = escrow.balances("room1", "alice");
  assert.equal(after.total, 0); // posted but unfunded: nothing payable yet
});

test("write path still migrates a legacy (pre-track) database", () => {
  const { storage } = makeStorage();
  const store = makeStore(storage);
  store.transaction(() => {
    convergeBountyDeployedSchema(store.db);
    store.db.exec(bountyEscrowSchema);
    // Degrade to the slice-1 shape: drop the migrated columns.
    for (const [table, col] of [
      ["bounty_journal", "track"], ["bounty_events", "track"],
      ["bounty_records", "state_changed_ms"],
    ]) store.db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
  });
  const colsBefore = new Set(store.db.prepare("PRAGMA table_info(bounty_records)").all().map(r => r.name));
  assert.ok(!colsBefore.has("state_changed_ms"));
  const escrow = new BountyEscrow(store, { allowLegacyStringLanes: true });
  escrow.postBounty("room1", {
    poster: "alice", title: "Fix the leak", criteria: "No more drips.",
    amount: 10, deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  const colsAfter = new Set(store.db.prepare("PRAGMA table_info(bounty_records)").all().map(r => r.name));
  assert.ok(colsAfter.has("state_changed_ms"), "migration must add the column on the write path");
  const nulls = store.db.prepare("SELECT COUNT(*) n FROM bounty_records WHERE state_changed_ms IS NULL").get().n;
  assert.equal(nulls, 0, "backfill must run when migration adds the column");
});
