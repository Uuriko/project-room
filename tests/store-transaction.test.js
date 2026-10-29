// S-02 fold-in pin: the spend-grants transaction seam lives in ONE named
// store-core adapter (server/store-transaction.mjs), not in a WeakMap
// registry private to spend-grants.mjs.
//
// Contracts owned here:
// - transactionForDb(db, fn) is the single bare-db transaction seam: it runs
//   fn through the runner RoomStore registered for that db at construction,
//   joins an already-open transaction (db.isTransaction) without invoking
//   the runner, and refuses an unregistered db loudly with the exact
//   pre-fold message — never by issuing raw BEGIN/COMMIT itself (on the
//   Durable Object runtime a raw BEGIN turned a 402 into a 500).
// - spend-grants.mjs no longer exports a registration surface of its own,
//   and the test tree carries no fourth transaction re-implementation
//   (tests/helpers/bare-db-transactions.mjs is deleted).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { registerStoreTransactionRunner, transactionForDb } from "../server/store-transaction.mjs";
import { RoomStore } from "../server/store.mjs";
import { ensureGrantsSchema } from "../server/grants.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";
import {
  ensureSpendGrantsSchema, issueSpendGrant, authorizeSpend, spendGrantSummary,
} from "../server/spend-grants.mjs";

test("transactionForDb refuses an unregistered database with the pre-fold message, running nothing", () => {
  const db = { isTransaction: false, exec() { throw new Error("raw SQL must never run"); } };
  let ran = 0;
  assert.throws(() => transactionForDb(db, () => { ran += 1; }),
    /spend-grants: no store transaction is registered for this database/);
  assert.equal(ran, 0);
});

test("transactionForDb runs through the registered runner and issues no raw transaction SQL", () => {
  const calls = [];
  const db = { isTransaction: false, exec(sql) { calls.push(sql); } };
  let wrapped = 0;
  registerStoreTransactionRunner(db, fn => { wrapped += 1; db.isTransaction = true; try { return fn(); } finally { db.isTransaction = false; } });
  assert.equal(transactionForDb(db, () => "done"), "done");
  assert.equal(wrapped, 1);
  assert.deepEqual(calls, [], "no BEGIN/COMMIT/ROLLBACK was executed on the database");
});

test("transactionForDb joins an open transaction without invoking the runner", () => {
  const db = { isTransaction: true };
  let wrapped = 0;
  registerStoreTransactionRunner(db, () => { wrapped += 1; });
  assert.equal(transactionForDb(db, () => "joined"), "joined");
  assert.equal(wrapped, 0);
});

test("spend-grants carries no transaction registry of its own any more", async () => {
  const spend = await import("../server/spend-grants.mjs");
  assert.equal(spend.registerTransactionRunner, undefined);
  const source = readFileSync(new URL("../server/spend-grants.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("registerTransactionRunner"), false);
  assert.equal(source.includes("transactionRunners"), false);
  assert.equal(existsSync(new URL("./helpers/bare-db-transactions.mjs", import.meta.url)), false,
    "the test tree's fourth transaction re-implementation is deleted");
});

test("a RoomStore-bound bare database transacts spend authorizations end to end", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  new RoomStore(null, { database: db });
  ensureGrantsSchema(db);
  ensureAutonomyTiersSchema(db);
  ensureSpendGrantsSchema(db);
  issueSpendGrant(db, "fold-room", "agent-a", { grantedBy: "owner", capCents: "100", perTxCapCents: "50", nowMs: 1000 });
  authorizeSpend(db, { roomId: "fold-room", agentId: "agent-a", toolName: "room_put_file", priceCents: 5, nonce: "F1", nowMs: 1000 });
  assert.equal(spendGrantSummary(db, "fold-room", "agent-a")?.remainingCents, "95");
  assert.throws(
    () => authorizeSpend(db, { roomId: "fold-room", agentId: "agent-a", toolName: "room_put_file", priceCents: 51, nonce: "F2", nowMs: 1000 }),
    error => error.code === "payment_required" && error.detail?.reason === "per_tx_cap_exceeded");
  assert.equal(spendGrantSummary(db, "fold-room", "agent-a")?.remainingCents, "95",
    "the refused authorize rolled back: counts unchanged");
});
