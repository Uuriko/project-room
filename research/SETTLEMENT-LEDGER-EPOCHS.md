# Multi-Epoch Settlement Ledger: Schema & Close-Out Semantics (200-hard-tasks #14)

Reference implementation: `server/settlement-ledger.mjs` (SQLite via
node:sqlite, amounts as TEXT raw units). Reconciler:
`scripts/ledger-reconcile.mjs`.

## Schema

```sql
epochs (
  id TEXT PRIMARY KEY,
  starts_at INTEGER NOT NULL,      -- ms epoch
  ends_at INTEGER,                 -- set at close
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed
  closed_at INTEGER
);

entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch_id TEXT NOT NULL REFERENCES epochs(id),
  kind TEXT NOT NULL,              -- deposit | claim | refund | fee
  job_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  asset_mint TEXT NOT NULL,
  amount_raw TEXT NOT NULL,        -- integer string, raw units, arbitrary precision
  tx_ref TEXT,                     -- chain transaction reference (nullable)
  created_at INTEGER NOT NULL
);

reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch_id TEXT NOT NULL REFERENCES epochs(id),
  ran_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,             -- 1 clean, 0 mismatches
  mismatches_json TEXT NOT NULL    -- every attempt journaled, pass or fail
);
```

Conservation invariant per epoch: `deposits == claims + refunds + fees`
(every unit that entered either paid a provider, returned to a payer, or
was taken as fee).

## Epoch close-out semantics

1. **Epochs are append-only while open.** `record()` rejects unknown epochs,
   closed epochs, bad kinds, and non-integer amounts.
2. **Close requires a clean reconciliation.** `closeEpoch(id, reconcileFn)`
   runs the reconciler first and journals the attempt; if mismatches exist
   the close is **blocked** (`RECONCILE_FAILED`) and the epoch stays open.
   Both failed and successful attempts are journaled — the reconciliation
   history is the audit trail.
3. **Close is terminal.** A closed epoch accepts no new entries. Corrections
   to a closed epoch go in a *new* epoch as adjusting entries referencing
   the original (`tx_ref` carries the correction link), never as edits —
   the ledger is append-only, like the chain it mirrors.
4. **Epoch boundaries.** Recommended: 24h epochs (UTC). An epoch's `ends_at`
   is the close time; entries are bucketed by `created_at`, so late-arriving
   chain data for a closed epoch lands in the *current* epoch as an
   adjustment, flagged by the reconciler as `missing-in-ledger` for the
   closed epoch only if someone re-runs it (expected — the adjustment is
   the resolution).

## Reconciliation

`reconcileEpoch(ledger, epochId, chainData)` matches ledger entries to
mocked on-chain records on the full key
`(kind, jobId, chainId, assetMint, txRef)` and flags:

| type | meaning | typical cause |
|---|---|---|
| missing-on-chain | ledger booked it, chain doesn't have it | phantom booking, dropped tx |
| missing-in-ledger | chain has it, ledger doesn't | unbooked movement, late data |
| amount-mismatch | both have it, amounts differ | tamper, decimal bug |

CLI: `node scripts/ledger-reconcile.mjs <ledger.db> <epoch> <chain.json> [--json]`
(exit 0 clean, 1 mismatches, 2 usage).

## What this does not do

- It does not *fetch* chain data — the chain-data provider (indexer,
  attestation poller) is a separate component; the reconciler takes its
  output as JSON. This keeps the ledger deterministic and testable.
- It does not resolve mismatches — it flags them. Resolution is an
  operator workflow (adjusting entries, incident per the tripwire rules,
  task #20).
