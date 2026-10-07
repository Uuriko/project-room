// Multi-epoch settlement accounting ledger (200-hard-tasks #14).
// Off-chain SQLite ledger tracking deposits, claims, refunds, and fees per
// epoch, reconcilable against on-chain state. Amounts stored as TEXT
// (raw units, arbitrary precision). Pure: node:sqlite only.
import { DatabaseSync } from "node:sqlite";

export const ENTRY_KINDS = Object.freeze(["deposit", "claim", "refund", "fee"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS epochs (
  id TEXT PRIMARY KEY,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch_id TEXT NOT NULL REFERENCES epochs(id),
  kind TEXT NOT NULL,
  job_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  asset_mint TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  tx_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_epoch ON entries(epoch_id);
CREATE INDEX IF NOT EXISTS idx_entries_job ON entries(job_id);
CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch_id TEXT NOT NULL REFERENCES epochs(id),
  ran_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  mismatches_json TEXT NOT NULL
);
`;

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function openLedger(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  function openEpoch(id, startsAt = Date.now()) {
    try {
      db.prepare("INSERT INTO epochs (id, starts_at, status) VALUES (?, ?, 'open')").run(id, startsAt);
    } catch (e) {
      throw new LedgerError("EPOCH_EXISTS", `epoch ${id} already exists`);
    }
    return { id, starts_at: startsAt, status: "open" };
  }

  function getEpoch(id) {
    return db.prepare("SELECT * FROM epochs WHERE id = ?").get(id) || null;
  }

  function record({ epochId, kind, jobId, chainId, assetMint, amountRaw, txRef = null, createdAt = Date.now() }) {
    if (!ENTRY_KINDS.includes(kind)) throw new LedgerError("BAD_KIND", `kind must be one of ${ENTRY_KINDS.join(",")}`);
    const epoch = getEpoch(epochId);
    if (!epoch) throw new LedgerError("NO_EPOCH", `epoch ${epochId} does not exist`);
    if (epoch.status !== "open") throw new LedgerError("EPOCH_CLOSED", `epoch ${epochId} is closed`);
    if (!/^\d+$/.test(String(amountRaw))) throw new LedgerError("BAD_AMOUNT", "amountRaw must be a non-negative integer string");
    const r = db
      .prepare(
        "INSERT INTO entries (epoch_id, kind, job_id, chain_id, asset_mint, amount_raw, tx_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(epochId, kind, jobId, chainId, assetMint, String(amountRaw), txRef, createdAt);
    return Number(r.lastInsertRowid);
  }

  function entriesFor(epochId) {
    return db.prepare("SELECT * FROM entries WHERE epoch_id = ? ORDER BY id").all(epochId);
  }

  // Per-kind totals for an epoch, as BigInt-valued strings.
  function totals(epochId) {
    const rows = db
      .prepare("SELECT kind, amount_raw FROM entries WHERE epoch_id = ?")
      .all(epochId);
    const totals = { deposit: 0n, claim: 0n, refund: 0n, fee: 0n };
    for (const r of rows) totals[r.kind] += BigInt(r.amount_raw);
    return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()]));
  }

  // Epoch close-out: the epoch must reconcile clean before it closes.
  // reconcileFn(epochId) -> { ok, mismatches } (see scripts/ledger-reconcile.mjs).
  function closeEpoch(id, reconcileFn, closedAt = Date.now()) {
    const epoch = getEpoch(id);
    if (!epoch) throw new LedgerError("NO_EPOCH", `epoch ${id} does not exist`);
    if (epoch.status !== "open") throw new LedgerError("EPOCH_CLOSED", `epoch ${id} already closed`);
    const { ok, mismatches } = reconcileFn(id);
    db.prepare("INSERT INTO reconciliations (epoch_id, ran_at, ok, mismatches_json) VALUES (?, ?, ?, ?)").run(
      id, closedAt, ok ? 1 : 0, JSON.stringify(mismatches)
    );
    if (!ok) {
      throw new LedgerError("RECONCILE_FAILED", `epoch ${id} has ${mismatches.length} mismatches; close-out blocked`);
    }
    db.prepare("UPDATE epochs SET status = 'closed', ends_at = ?, closed_at = ? WHERE id = ?").run(closedAt, closedAt, id);
    return { id, status: "closed", closedAt };
  }

  function reconciliationsFor(epochId) {
    return db.prepare("SELECT * FROM reconciliations WHERE epoch_id = ? ORDER BY id").all(epochId);
  }

  function close() {
    db.close();
  }

  return { openEpoch, getEpoch, record, entriesFor, totals, closeEpoch, reconciliationsFor, close, db };
}
