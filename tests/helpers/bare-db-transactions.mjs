// Test-only: bare node:sqlite databases (no RoomStore) have no registered store
// transaction, so authorizeSpend refuses them. Register the same BEGIN IMMEDIATE
// semantics the store's node:sqlite platform uses. Raw SQL is fine in tests;
// the no-raw-transaction rule only covers server/.
import { registerTransactionRunner } from "../../server/spend-grants.mjs";

export function registerBareTransactions(db) {
  registerTransactionRunner(db, fn => {
    db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); db.exec("COMMIT"); return out; }
    catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  });
  return db;
}
