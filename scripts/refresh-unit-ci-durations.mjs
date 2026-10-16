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
// - malformed receipts fail closed (no output is written);
// - the legacy measurement cap (MEASUREMENT_CAP_MS) is a lower bound, not
//   a measurement: an entry still sitting at the cap that this refresh did
//   not measure is listed in the provenance key's `cappedLowerBounds`, and
//   an entry this refresh measured off the cap is listed in
//   `uncappedFiles`. Hosted receipts carry per-testcase JUnit sums (see
//   scripts/unit-ci.mjs), which have no per-file cap, so a measured value
//   replaces a capped sentinel outright — it is never averaged with it.
//
// Output is deterministic: `milliseconds` keys sorted, 1-space indent
// (the existing file's format), trailing newline. Re-running on the same
// receipts is a no-op.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROVENANCE_KEY = "hostedReceiptsRefresh";

// The 2026-10-06 measurement harness killed each file at 300 s and recorded
// the cap itself as the duration (see the table's `_note`). An entry at
// exactly this value is therefore a lower bound — the file ran AT LEAST
// this long under that harness — never a measured duration. (Hosted JUnit
// testcase sums routinely show the same files far below the cap: the cap
// was a solo wall-clock timeout under 16-way contention, not test time.)
export const MEASUREMENT_CAP_MS = 300000;

/**
 * Files whose recorded duration is a capped lower bound: at (or above) the
 * measurement cap AND not freshly measured in this refresh. A file that WAS
 * measured — even if its measured value lands near the cap — is a real
 * measurement and is not flagged.
 */
export function cappedLowerBoundFiles(milliseconds, measuredFiles = new Set()) {
  return Object.entries(milliseconds ?? {})
    .filter(([file, ms]) => Number.isFinite(ms) && ms >= MEASUREMENT_CAP_MS && !measuredFiles.has(file))
    .map(([file]) => file)
    .sort();
}

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

// Generated-twin attribution: a test file that only materializes and
// imports a generated sibling (tests/webhook-dispatch-store.test.js writes
// tests/.webhook-dispatch-store.<hash>.generated.mjs and imports it) has
// its testcases reported under the GENERATED file's path, which does not
// exist in a fresh checkout. Without this rule the refresh drops that
// measurement and the wrapper keeps whatever stale weight it had — for
// that file, a 149,653 ms legacy weight against 3,085 ms of measured
// hosted testcase time, the single largest distortion in the old table.
// The rule is narrow: a dotfile basename `.<base>.<hex>.generated.<ext>`
// is attributed to `<base>.test.<ext>` in the same directory, and only
// when exactly one such sibling exists.
const GENERATED_TWIN = /^\.(.+)\.[0-9a-f]{8,}\.generated\.([a-z]+)$/;
export function generatedTwinTarget(file, fileExists) {
  const slash = file.lastIndexOf("/");
  const dir = slash >= 0 ? file.slice(0, slash) : "";
  const base = slash >= 0 ? file.slice(slash + 1) : file;
  const match = GENERATED_TWIN.exec(base);
  if (!match) return null;
  const candidates = ["js", "mjs", "cjs", "ts", "mts", "cts"]
    .map((ext) => `${dir ? `${dir}/` : ""}${match[1]}.test.${ext}`)
    .filter((candidate) => candidate !== file && fileExists(candidate));
  return candidates.length === 1 ? candidates[0] : null;
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

  // Re-key measurements whose reported file is a generated twin of an
  // existing test file (see generatedTwinTarget); other measurements for
  // files absent from the tree are dropped as stale, as before.
  const effectiveMeasured = new Map();
  for (const [file, ms] of measured) {
    const target = fileExists(file) ? file : generatedTwinTarget(file, fileExists);
    if (target && (!effectiveMeasured.has(target) || ms > effectiveMeasured.get(target))) {
      effectiveMeasured.set(target, ms);
    }
  }

  const entries = new Map();
  for (const [file, ms] of Object.entries(existing.milliseconds)) {
    if (fileExists(file)) entries.set(file, ms);
  }
  for (const [file, ms] of effectiveMeasured) {
    entries.set(file, ms);
  }

  const runIds = [...new Set(receipts.map((r) => r.runId).filter((v) => v !== undefined && v !== null && v !== "").map(String))].sort();
  const revisions = [...new Set(receipts.map((r) => r.revision).filter((v) => v !== undefined && v !== null && v !== "").map(String))].sort();
  const cappedLowerBounds = cappedLowerBoundFiles(Object.fromEntries(entries), effectiveMeasured);
  const uncappedFiles = [...effectiveMeasured.keys()]
    .filter((file) => existing.milliseconds[file] >= MEASUREMENT_CAP_MS)
    .sort();
  const provenance = {
    date,
    source: "hosted unit-shard receipts (fileDurationsMs written by scripts/unit-ci.mjs)",
    runIds,
    revisions,
    filesMeasured: effectiveMeasured.size,
    cappedLowerBounds,
    uncappedFiles,
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
  const capped = table[PROVENANCE_KEY]?.cappedLowerBounds ?? [];
  console.log(`refresh-unit-ci-durations: refreshed ${measuredCount} measured file(s) from ${receipts.length} receipt(s) into ${outPath}; ${capped.length} capped lower-bound file(s) remain${capped.length ? `: ${capped.join(", ")}` : ""}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) main();
