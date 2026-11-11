#!/usr/bin/env node
// flaky-merge.mjs — TST-01B. Merge shard reports into quarantine proposals.
//
//   node scripts/flaky-merge.mjs <shard-dir-or-json> [--today=YYYY-MM-DD] [--repo=path]
//
// Reads detectFlaky records (file + tests[] or flaky[] with passes/fails).
// A test is mixed when the combined shards have both passes and fails.
// Prints {"quarantined":[...]} in the shape scripts/quarantine-check.mjs accepts.
// Owner is the last committer of the test file. repair_by is 14 days after today.
// shard-summary.json is skipped. Exit 1 when a proposal is printed, 0 when
// none, 2 on usage or unreadable input. Does not edit tests/quarantine.json.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPAIR_DAYS = 14;

export function addIsoDays(iso, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error("today must be YYYY-MM-DD");
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) {
    throw new Error("today must be YYYY-MM-DD");
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function lastCommitter(repo, file, spawnImpl = spawnSync) {
  if (typeof file !== "string" || !file.trim()) return null;
  const rel = path.isAbsolute(file) ? path.relative(repo, file) : file;
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const result = spawnImpl("git", ["-C", repo, "log", "-1", "--format=%an", "--", rel], { encoding: "utf8" });
  if (!result || result.status !== 0) return null;
  const name = String(result.stdout || "").split("\n")[0].trim();
  return name || null;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function absorb(map, file, name, passes, fails) {
  if (typeof file !== "string" || !file.trim() || typeof name !== "string" || !name.trim()) return;
  if (passes == null || fails == null) return;
  const key = `${file}\0${name}`;
  const row = map.get(key) || { file, name, passes: 0, fails: 0 };
  row.passes += passes;
  row.fails += fails;
  map.set(key, row);
}

function absorbRecord(map, record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const rows = Array.isArray(record.tests) ? record.tests : Array.isArray(record.flaky) ? record.flaky : null;
  if (!rows) return;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    absorb(map, record.file, row.name, count(row.passes), count(row.fails));
  }
}

export function readShardInputs(inputPath, fsImpl = { readFileSync, readdirSync, statSync }) {
  const records = [];
  const take = (filePath) => {
    if (path.basename(filePath) === "shard-summary.json") return;
    if (!filePath.endsWith(".json")) return;
    let parsed;
    try {
      parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(`cannot parse ${filePath}: ${err.message}`);
    }
    if (Array.isArray(parsed)) records.push(...parsed);
    else records.push(parsed);
  };
  const walk = (dir) => {
    for (const name of fsImpl.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fsImpl.statSync(full).isDirectory()) walk(full);
      else take(full);
    }
  };
  let info;
  try {
    info = fsImpl.statSync(inputPath);
  } catch (err) {
    throw new Error(`cannot read ${inputPath}: ${err.message}`);
  }
  if (info.isDirectory()) walk(inputPath);
  else take(inputPath);
  return records;
}

export function mixedTests(records) {
  const map = new Map();
  for (const record of records) absorbRecord(map, record);
  return [...map.values()]
    .filter((row) => row.passes > 0 && row.fails > 0)
    .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

export function proposeQuarantine(mixed, { today, committer }) {
  const repairBy = addIsoDays(today, REPAIR_DAYS);
  return {
    quarantined: mixed.map((row) => {
      const owner = committer(row.file);
      return {
        test: `${row.file} > ${row.name}`,
        reason: `mixed outcomes: ${row.passes} pass / ${row.fails} fail`,
        ...(owner ? { owner } : {}),
        quarantined_at: today,
        repair_by: repairBy,
      };
    }),
  };
}

export function parseArgs(argv, cwd = process.cwd()) {
  const opts = { input: null, today: new Date().toISOString().slice(0, 10), repo: cwd };
  for (const arg of argv) {
    if (arg.startsWith("--today=")) opts.today = arg.slice("--today=".length);
    else if (arg.startsWith("--repo=")) opts.repo = arg.slice("--repo=".length);
    else if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    else if (opts.input == null) opts.input = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!opts.input) throw new Error("usage: node scripts/flaky-merge.mjs <shard-dir-or-json> [--today=YYYY-MM-DD] [--repo=path]");
  addIsoDays(opts.today, 0);
  return opts;
}

function isCli() {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isCli()) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const proposal = proposeQuarantine(mixedTests(readShardInputs(opts.input)), {
      today: opts.today,
      committer: (file) => lastCommitter(opts.repo, file),
    });
    process.stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
    console.error(`flaky-merge: ${proposal.quarantined.length} proposed quarantine entr${proposal.quarantined.length === 1 ? "y" : "ies"}`);
    process.exit(proposal.quarantined.length > 0 ? 1 : 0);
  } catch (err) {
    console.error(`flaky-merge: ${err.message}`);
    process.exit(2);
  }
}
