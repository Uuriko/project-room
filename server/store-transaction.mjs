// Store-core bare-db transaction adapter.
//
// Bare-db consumers (server/spend-grants.mjs) receive a raw db — not the
// store — yet their writes must run inside the store's platform
// transaction (RoomStore.transaction), never raw BEGIN/COMMIT: the Durable
// Object wrapper cannot execute raw transaction SQL, so a raw BEGIN there
// turned a 402 into a 500 on that runtime. This module is the single named
// seam for that: RoomStore registers its runner for its database at
// construction (server/store.mjs), and bare-db consumers call
// transactionForDb(db, fn).
//
// This module does not import server/store.mjs (store imports it); the
// registry is the dependency inversion that keeps the cycle out — the same
// shape as the isolated wake runner in server/wake-transaction.mjs, with
// one deliberate difference: this runner is the store's NON-isolated
// transaction, and a caller already inside a transaction (db.isTransaction)
// just runs fn, exactly as spend-grants' private registry did before the
// fold-in (S-02).
//
// Registry-miss behaviour: FAIL CLOSED. transactionForDb throws before fn
// runs — no write is attempted and no raw-SQL fallback exists. Every
// production db is RoomStore-owned and registered at construction, so a
// miss is a wiring bug, not a runtime case; bare databases in tests bind a
// runner by constructing a RoomStore over the db, not by re-implementing
// transaction semantics in the test tree.
const storeTransactionRunners = new WeakMap();
export function registerStoreTransactionRunner(db, run) { storeTransactionRunners.set(db, run); }
export function transactionForDb(db, fn) {
  if (db.isTransaction) return fn();
  const run = storeTransactionRunners.get(db);
  if (typeof run !== "function") throw new Error("spend-grants: no store transaction is registered for this database");
  return run(fn);
}
