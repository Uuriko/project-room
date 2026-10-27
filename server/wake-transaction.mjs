// Isolated transaction runner registry for wake accounting.
//
// recordWakeEvent (server/wake-metrics.mjs) receives only a raw db — its
// signature is fixed by its ~18 call sites, none of which holds a store
// handle — yet its counter insert and failure-journal insert must commit
// or roll back together, ISOLATED from any transaction the caller already
// holds: when a wake is recorded inside a caller's transaction (e.g. the
// agent-heartbeats ack path), a journal failure must roll back only the
// accounting writes, never the caller's work, and must not leave the
// counter to commit with the caller's transaction either (audit D3-5 P1).
//
// The spend-grants registry (server/spend-grants.mjs) cannot serve this:
// its runner is the store's NON-isolated transaction, which joins the
// caller's open transaction. This registry holds the isolated runner
// instead — RoomStore registers `fn => this.transaction(fn, { isolated:
// true })` for its db at construction, alongside the spend-grants
// registration. store.transaction(fn, { isolated: true }) supplies
// exactly the required semantics on both platforms: a SAVEPOINT on Node
// (nodeStorage), a nested transactionSync on a Durable Object (whose
// runtime forbids raw SAVEPOINT), and BEGIN IMMEDIATE / COMMIT with
// rollback when outermost.
//
// Registry-miss behaviour: FAIL CLOSED. runWakeTransaction throws before
// fn runs — no write is attempted, so a miss can never produce a partial
// (counter-without-journal) record, and no silent non-atomic fallback
// exists. recordWakeEvent catches the throw and reports it through its
// central failure counter, like any other write failure. Every production
// db is RoomStore-owned and registered at construction, so a miss is a
// wiring bug, not a runtime case; bare databases in tests register a
// test runner explicitly (tests/helpers/bare-db-isolated-transactions.mjs),
// mirroring the spend-grants bare-db helper.
const isolatedTransactionRunners = new WeakMap();
export function registerWakeTransactionRunner(db, run) { isolatedTransactionRunners.set(db, run); }
export function runWakeTransaction(db, fn) {
  const run = isolatedTransactionRunners.get(db);
  if (typeof run !== "function")
    throw new Error("wake-transaction: no isolated store transaction is registered for this database");
  return run(fn);
}
