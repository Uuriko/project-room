#!/usr/bin/env node
// Report the unit shard planner's balance for the committed durations
// table (scripts/unit-ci-durations.json), optionally scored against
// measured per-file durations from a directory of hosted shard receipts.
//
// Usage:
//   node scripts/unit-durations-report.mjs [--truth RECEIPTS_DIR]
//                                          [--check-fresh-days N]
//
// - The plan comes from scripts/unit-shards.mjs (the planner CI uses).
// - `--truth` scores that plan against receipt `fileDurationsMs` (the sum
//   of per-testcase JUnit times per file, written by scripts/unit-ci.mjs):
//   it answers "if the files ran with these measured times, how balanced
//   would this plan's shards be?" — the honest before/after check when the
//   truth receipts come from a run the weights were NOT derived from.
// - Entries at the legacy 300 s measurement cap are lower bounds, not
//   measurements (see scripts/refresh-unit-ci-durations.mjs); they are
//   listed explicitly, never silently treated as truth.
// - `--check-fresh-days N` exits 1 when the table's last hosted-receipts
//   refresh is older than N days (the staleness alarm for the refresh
//   workflow; callers turn the failure into a warning as they see fit).
//
// Zero dependencies; read-only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unitPlan } from "./unit-shards.mjs";
import {
  loadReceipts,
  measuredFromReceipts,
  cappedLowerBoundFiles,
  generatedTwinTarget,
  PROVENANCE_KEY,
} from "./refresh-unit-ci-durations.mjs";

// Receipt truth, with generated-twin measurements re-keyed to their
// wrapper test files (same rule as the refresh, so a plan is scored
// against the same file set it plans). Exported for tests.
export function truthFromReceipts(receipts, fileExists = (file) => existsSync(join(process.cwd(), file))) {
  const truth = new Map();
  for (const [file, ms] of measuredFromReceipts(receipts)) {
    const target = fileExists(file) ? file : generatedTwinTarget(file, fileExists);
    const key = target ?? file;
    if (!truth.has(key) || ms > truth.get(key)) truth.set(key, ms);
  }
  return truth;
}

export function summarizePlan(plan, truthMs = null) {
  const shards = plan.shards.map((shard) => {
    let truthTotal = 0;
    let truthFiles = 0;
    if (truthMs) {
      for (const file of shard.files) {
        const ms = truthMs.get ? truthMs.get(file) : truthMs[file];
        if (Number.isFinite(ms)) {
          truthTotal += ms;
          truthFiles += 1;
        }
      }
    }
    return {
      index: shard.index,
      files: shard.files.length,
      estimatedMs: shard.estimatedMs,
      truthMs: truthMs ? truthTotal : null,
      truthFiles: truthMs ? truthFiles : null,
    };
  });
  const spread = (values) => {
    const nums = values.filter((v) => Number.isFinite(v));
    if (!nums.length) return null;
    const min = Math.min(...nums);
    return min > 0 ? Math.max(...nums) / min : null;
  };
  return {
    shards,
    estimatedSpread: spread(shards.map((s) => s.estimatedMs)),
    truthSpread: truthMs ? spread(shards.map((s) => s.truthMs)) : null,
  };
}

const secs = (ms) => (ms / 1000).toFixed(1);

export function renderReport({ plan, table, truthMs = null, truthLabel = null, now = new Date() }) {
  const summary = summarizePlan(plan, truthMs);
  const capped = cappedLowerBoundFiles(table.milliseconds);
  const provenance = table[PROVENANCE_KEY] ?? null;
  const lines = [];
  lines.push("## Unit durations report");
  lines.push("");
  if (provenance) {
    lines.push(`- Last hosted-receipts refresh: ${provenance.date} (runs: ${(provenance.runIds ?? []).join(", ") || "?"})`);
  } else {
    lines.push("- Last hosted-receipts refresh: none recorded");
  }
  lines.push(`- Files in plan: ${plan.files.length}; files in table: ${Object.keys(table.milliseconds).length}`);
  lines.push(`- Capped lower-bound files (at the 300 s legacy cap, NOT measured): ${capped.length}${capped.length ? ` — ${capped.join(", ")}` : ""}`);
  lines.push("");
  lines.push("| Shard | Files | Planner estimate (s) |" + (truthMs ? " Measured truth (s) | Files scored |" : ""));
  lines.push("|---|---|---|" + (truthMs ? "---|---|" : ""));
  for (const shard of summary.shards) {
    lines.push(
      `| ${shard.index} | ${shard.files} | ${secs(shard.estimatedMs)} |` +
        (truthMs ? ` ${secs(shard.truthMs)} | ${shard.truthFiles} |` : "")
    );
  }
  lines.push("");
  lines.push(`- Planner-estimate spread (max/min): ${summary.estimatedSpread?.toFixed(3) ?? "n/a"}`);
  if (truthMs) {
    lines.push(`- Measured-truth spread (max/min), truth = ${truthLabel ?? "receipts"}: ${summary.truthSpread?.toFixed(3) ?? "n/a"}`);
  }
  void now;
  return lines.join("\n") + "\n";
}

export function tableAgeDays(table, now = new Date()) {
  const date = table?.[PROVENANCE_KEY]?.date;
  if (!date) return null;
  const refreshed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(refreshed)) return null;
  return Math.floor((now.getTime() - refreshed) / 86400000);
}

function main() {
  const args = process.argv.slice(2);
  let truthDir = null;
  let freshDays = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--truth") truthDir = args[++i];
    else if (args[i] === "--check-fresh-days") freshDays = Number(args[++i]);
    else throw new Error(`Usage: node scripts/unit-durations-report.mjs [--truth RECEIPTS_DIR] [--check-fresh-days N] (unknown arg: ${args[i]})`);
  }
  const table = JSON.parse(readFileSync(new URL("./unit-ci-durations.json", import.meta.url), "utf8"));
  const plan = unitPlan();
  let truthMs = null;
  if (truthDir) truthMs = truthFromReceipts(loadReceipts(truthDir));
  process.stdout.write(renderReport({ plan, table, truthMs, truthLabel: truthDir ? `receipts in ${truthDir}` : null }));
  if (freshDays !== null) {
    if (!Number.isFinite(freshDays) || freshDays < 0) throw new Error("--check-fresh-days must be a non-negative number");
    const age = tableAgeDays(table);
    if (age === null) {
      console.log(`freshness: no hosted-receipts refresh recorded (limit ${freshDays}d) — STALE`);
      process.exit(1);
    }
    console.log(`freshness: table refreshed ${age}d ago (limit ${freshDays}d) — ${age > freshDays ? "STALE" : "ok"}`);
    if (age > freshDays) process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) main();
