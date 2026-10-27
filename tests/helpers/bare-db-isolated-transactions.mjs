// Test-only: bare node:sqlite databases (no RoomStore) have no registered
// isolated wake transaction, so recordWakeEvent fails closed on them.
// Register the same isolated semantics the store's platforms use
// (server/store.mjs nodeStorage / cloudflare durableStorage): BEGIN
// IMMEDIATE when outermost, a SAVEPOINT when the caller already holds a
// transaction, rolling back only this run's writes on a throw. Raw SQL is
// fine in tests; the no-raw-transaction rule only covers server/.
import { registerWakeTransactionRunner } from "../../server/wake-transaction.mjs";

export function registerBareIsolatedTransactions(db) {
  registerWakeTransactionRunner(db, fn => {
    if (db.isTransaction) {
      db.exec("SAVEPOINT room_isolated_write");
      try { const out = fn(); db.exec("RELEASE room_isolated_write"); return out; }
      catch (error) {
        try { db.exec("ROLLBACK TO room_isolated_write"); db.exec("RELEASE room_isolated_write"); }
        catch { /* already rolled back */ }
        throw error;
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); db.exec("COMMIT"); return out; }
    catch (error) { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } throw error; }
  });
  return db;
}
