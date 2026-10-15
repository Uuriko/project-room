#!/usr/bin/env node
// Regenerate scripts/unit-ci-durations.json from hosted unit-shard receipts.
//
// Usage: node scripts/refresh-unit-ci-durations.mjs RECEIPTS_DIR [OUT_PATH]
//
// RECEIPTS_DIR is a directory of unit-shard-*.json receipts in the layout
// the `unit` aggregator job downloads (see .github/workflows/test.yml):
// one JSON file per shard, each optionally carrying `fileDurationsMs`
// (per-file measured ms from that actual hosted run, written by
// scripts/unit-ci.mjs). OUT_PATH defaults to scripts/unit-ci-durations.json.
//
// Rules:
// - a file's new duration is the receipt-measured ms; when several
//   receipts cover the same file, the max wins (conservative for
//   balancing);
// - existing entries for files absent from the receipts are preserved;
// - entries (existing or measured) for files that no longer exist in the
//   tree are dropped — stale rows are dead weight;
// - non-`milliseconds` provenance keys in the existing table are
//   preserved, and one provenance key (`hostedReceiptsRefresh`) records
//   this refresh's source run ids / revisions and date;
// - receipts without `fileDurationsMs` contribute nothing, and when no
//   receipt carries any measured duration the table is left unchanged;
// - malformed receipts fail closed (no output is written).
//
// Output is deterministic: `milliseconds` keys sorted, 1-space indent
// (the existing file's format), trailing newline. Re-running on the same
// receipts is a no-op.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROVENANCE_KEY = "hostedReceiptsRefresh";

export function validateReceipt(receipt, name = "receipt") {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`refresh-unit-ci-durations: ${name} is not a JSON object`);
  }
  if (receipt.fileDurationsMs === undefined) return receipt;
  const durations = receipt.fileDurationsMs;
  if (!durations || typeof durations !== "object" || Array.isArray(durations)) {
    throw new Error(`refresh-unit-ci-durations: ${name} has malformed fileDurationsMs (expected an object)`);
  }
  for (const [file, ms] of Object.entries(durations)) {
    if (!file || typeof file !== "string") {
      throw new Error(`refresh-unit-ci-durations: ${name} has a malformed fileDurationsMs key`);
    }
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`refresh-unit-ci-durations: ${name} has a malformed fileDurationsMs value for ${file}`);
    }
  }
  return receipt;
}

export function loadReceipts(receiptsDir) {
  const names = readdirSync(receiptsDir)
    .filter((name) => /^unit-shard-.*\.json$/.test(name))
    .sort();
  return names.map((name) => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(receiptsDir, name), "utf8"));
    } catch (error) {
      throw new Error(`refresh-unit-ci-durations: ${name} is not valid JSON: ${error.message}`);
    }
    return validateReceipt(parsed, name);
  });
}

// Max measured ms per file across all receipts.
export function measuredFromReceipts(receipts) {
  const measured = new Map();
  for (const receipt of receipts) {
    validateReceipt(receipt);
    for (const [file, ms] of Object.entries(receipt.fileDurationsMs ?? {})) {
      const value = Math.round(ms);
      if (!measured.has(file) || value > measured.get(file)) measured.set(file, value);
    }
  }
  return measured;
}

function sortedMilliseconds(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Build the refreshed table. Pure: `fileExists(file)` decides whether a
 * repo-relative path still exists in the tree; `date` is the refresh date
 * (ISO yyyy-mm-dd) recorded in the provenance note.
 * Returns { table, changed, measuredCount } where `changed` compares the
 * serialized output against the serialized existing table under the same
 * deterministic format — except the no-measured-durations case, which is
 * always unchanged (the caller must not rewrite the file).
 */
export function refreshTable(existing, receipts, { fileExists = () => true, date = new Date().toISOString().slice(0, 10) } = {}) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)
    || !existing.milliseconds || typeof existing.milliseconds !== "object" || Array.isArray(existing.milliseconds)) {
    throw new Error("refresh-unit-ci-durations: existing durations table is malformed (expected an object with a milliseconds object)");
  }
  for (const [file, ms] of Object.entries(existing.milliseconds)) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`refresh-unit-ci-durations: existing durations table has a malformed value for ${file}`);
    }
  }
  const measured = measuredFromReceipts(receipts);
  if (!measured.size) return { table: existing, changed: false, measuredCount: 0 };

  const entries = new Map();
  for (const [file, ms] of Object.entries(existing.milliseconds)) {
    if (fileExists(file)) entries.set(file, ms);
  }
  for (const [file, ms] of measured) {
    if (fileExists(file)) entries.set(file, ms);
  }

  const runIds = [...new Set(receipts.map((r) => r.runId).filter((v) => v !== undefined && v !== null && v !== "").map(String))].sort();
  const revisions = [...new Set(receipts.map((r) => r.revision).filter((v) => v !== undefined && v !== null && v !== "").map(String))].sort();
  const provenance = {
    date,
    source: "hosted unit-shard receipts (fileDurationsMs written by scripts/unit-ci.mjs)",
    runIds,
    revisions,
    filesMeasured: [...measured.keys()].filter((file) => fileExists(file)).length,
    purpose: "Measured allocation only; test discovery remains authoritative. Timing allocates files only, not membership.",
  };

  const table = {};
  for (const key of Object.keys(existing)) {
    if (key === "milliseconds") table.milliseconds = sortedMilliseconds(entries);
    else if (key === PROVENANCE_KEY) table[key] = provenance;
    else table[key] = existing[key];
  }
  if (!("milliseconds" in table)) table.milliseconds = sortedMilliseconds(entries);
  if (!(PROVENANCE_KEY in table)) table[PROVENANCE_KEY] = provenance;

  return { table, changed: serializeTable(table) !== serializeTable(existing), measuredCount: provenance.filesMeasured };
}

export function serializeTable(table) {
  return JSON.stringify(table, null, 1) + "\n";
}

function main() {
  const [receiptsDir, outPathArg, ...rest] = process.argv.slice(2);
  if (!receiptsDir || rest.length) {
    throw new Error("Usage: node scripts/refresh-unit-ci-durations.mjs RECEIPTS_DIR [OUT_PATH]");
  }
  const outPath = outPathArg ?? "scripts/unit-ci-durations.json";
  if (!existsSync(outPath)) throw new Error(`refresh-unit-ci-durations: durations table not found: ${outPath}`);
  const existing = JSON.parse(readFileSync(outPath, "utf8"));
  const receipts = loadReceipts(receiptsDir);
  // The tree root is the parent of the `scripts/` directory holding the
  // durations table when OUT_PATH has that shape; otherwise the cwd.
  const outDir = dirname(resolve(outPath));
  const root = outDir.split(/[\\/]/).pop() === "scripts" ? dirname(outDir) : process.cwd();
  const { table, changed, measuredCount } = refreshTable(existing, receipts, {
    fileExists: (file) => existsSync(join(root, file)),
  });
  if (!changed) {
    console.log("refresh-unit-ci-durations: no change (table already matches the receipts)");
    return;
  }
  writeFileSync(outPath, serializeTable(table));
  console.log(`refresh-unit-ci-durations: refreshed ${measuredCount} measured file(s) from ${receipts.length} receipt(s) into ${outPath}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) main();
