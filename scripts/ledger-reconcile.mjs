// Settlement ledger reconciler (200-hard-tasks #14).
// Compares the off-chain ledger for an epoch against mocked on-chain data
// and flags every mismatch. Mocked chain data shape (JSON):
//   { deposits: [{ jobId, chainId, assetMint, amountRaw, txRef }],
//     claims:   [...], refunds: [...], fees: [...] }
// Flags:
//   missing-on-chain  — ledger has the entry, chain does not (phantom booking)
//   missing-in-ledger — chain has the entry, ledger does not (unbooked movement)
//   amount-mismatch   — both have it, amounts differ (tamper or bug)
// Matching key: (kind, jobId, chainId, assetMint, txRef).
// CLI: node scripts/ledger-reconcile.mjs <ledger.db> <epoch> <chain.json> [--json]
import { readFileSync } from "node:fs";
import { openLedger } from "../server/settlement-ledger.mjs";

const KINDS = ["deposit", "claim", "refund", "fee"];

export function reconcileEpoch(ledger, epochId, chainData) {
  const mismatches = [];
  const ledgerEntries = ledger.entriesFor(epochId);
  const byKey = new Map();
  for (const e of ledgerEntries) {
    byKey.set([e.kind, e.job_id, e.chain_id, e.asset_mint, e.tx_ref || ""].join("|"), e);
  }
  const chainByKey = new Map();
  for (const kind of KINDS) {
    for (const c of chainData[kind + "s"] || chainData[kind] || []) {
      chainByKey.set([kind, c.jobId, c.chainId, c.assetMint, c.txRef || ""].join("|"), c);
    }
  }
  for (const [key, e] of byKey) {
    const c = chainByKey.get(key);
    if (!c) {
      mismatches.push({ type: "missing-on-chain", kind: e.kind, jobId: e.job_id, amountRaw: e.amount_raw, txRef: e.tx_ref });
    } else if (String(c.amountRaw) !== String(e.amount_raw)) {
      mismatches.push({
        type: "amount-mismatch", kind: e.kind, jobId: e.job_id,
        ledgerAmount: e.amount_raw, chainAmount: String(c.amountRaw), txRef: e.tx_ref,
      });
    }
  }
  for (const [key, c] of chainByKey) {
    if (!byKey.has(key)) {
      const kind = key.split("|")[0];
      mismatches.push({ type: "missing-in-ledger", kind, jobId: c.jobId, amountRaw: String(c.amountRaw), txRef: c.txRef });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// Deterministic mocked chain data generator for tests/demos: mirrors the
// ledger with optional injected faults.
export function mockChainData(ledgerEntries, { dropTxRefs = [], tamper = {}, extra = [] } = {}) {
  const data = { deposits: [], claims: [], refunds: [], fees: [] };
  for (const e of ledgerEntries) {
    if (dropTxRefs.includes(e.tx_ref)) continue; // simulate a missing on-chain record
    const amountRaw = tamper[e.tx_ref] || e.amount_raw;
    data[e.kind + "s"].push({
      jobId: e.job_id, chainId: e.chain_id, assetMint: e.asset_mint, amountRaw, txRef: e.tx_ref,
    });
  }
  for (const x of extra) data[x.kind + "s"].push(x); // unbooked on-chain movement
  return data;
}

const isCli = process.argv[1] && process.argv[1].endsWith("ledger-reconcile.mjs");
if (isCli) {
  const [dbPath, epochId, chainFile, flag] = process.argv.slice(2);
  if (!dbPath || !epochId || !chainFile) {
    console.error("usage: ledger-reconcile.mjs <ledger.db> <epoch> <chain.json> [--json]");
    process.exit(2);
  }
  const ledger = openLedger(dbPath);
  try {
    const chainData = JSON.parse(readFileSync(chainFile, "utf8"));
    const result = reconcileEpoch(ledger, epochId, chainData);
    if (flag === "--json") {
      console.log(JSON.stringify(result, null, 1));
    } else if (result.ok) {
      console.log(`epoch ${epochId}: RECONCILED — ledger matches chain data`);
    } else {
      console.log(`epoch ${epochId}: ${result.mismatches.length} MISMATCHES`);
      for (const m of result.mismatches) {
        console.log(`  [${m.type}] ${m.kind} job=${m.jobId} tx=${m.txRef || "-"}` +
          (m.ledgerAmount ? ` ledger=${m.ledgerAmount} chain=${m.chainAmount}` : m.amountRaw ? ` amount=${m.amountRaw}` : ""));
      }
    }
    process.exit(result.ok ? 0 : 1);
  } finally {
    ledger.close();
  }
}
