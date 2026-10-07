// Operator CLI for the disposable-log retention job (200-hard-tasks #176).
//
// Wraps server/retention-run.mjs runLiveStoreRetention against a sqlite file.
// Dry-run by default: prints the plan (table, cutoff, eligible rows) and
// deletes nothing. --apply actually deletes, and still honors
// ROOM_RETENTION_ALLOW_DELETION=0 (plan-only) when the operator sets it.
//
// The job only ever touches the disposable-log tables in RETENTION_TABLES
// (web_fetch_log, web_research_log). Room events, commands, security audit
// rows, invitations, activity, and webhook deliveries are never in the plan.
// One table per invocation, in rotation; batches are capped at 100 rows and
// run in a single transaction (a failure rolls the batch back).
//
// Usage:
//   node scripts/retention-plan.mjs --db /path/to/room.sqlite [--table-index N]
//       [--apply] [--limit N] [--now <ISO timestamp>]
//
// Exit codes: 0 the plan ran (dry-run or applied), 1 invalid usage or a
// refusal (unknown schema, unreadable DB), 2 a deletion batch failed.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { runLiveStoreRetention, RETENTION_TABLES, RETENTION_BATCH_LIMIT } from "../server/retention-run.mjs";

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? null;
};
const flag = name => args.includes(`--${name}`);

function usage(message) {
  if (message) console.error(`retention-plan: ${message}`);
  console.error("usage: node scripts/retention-plan.mjs --db <path> [--table-index N] [--apply] [--limit N] [--now <ISO>]");
  process.exit(1);
}

const dbPath = opt("db");
if (!dbPath) usage("--db is required");
// Validate cheap argument shapes before touching the filesystem, so usage
// errors are reported deterministically regardless of db state.
const tableIndex = opt("table-index") === null ? 0 : Number(opt("table-index"));
if (!Number.isInteger(tableIndex) || tableIndex < 0) usage("--table-index must be a non-negative integer");
const limit = opt("limit") === null ? RETENTION_BATCH_LIMIT : Number(opt("limit"));
if (!Number.isInteger(limit) || limit < 1 || limit > RETENTION_BATCH_LIMIT) {
  usage(`--limit must be an integer 1..${RETENTION_BATCH_LIMIT}`);
}
const nowOpt = opt("now");
if (nowOpt !== null && Number.isNaN(Date.parse(nowOpt))) usage("--now must be an ISO timestamp");
if (!existsSync(dbPath)) usage(`database not found: ${dbPath}`);

const spec = RETENTION_TABLES[tableIndex % RETENTION_TABLES.length];
// Dry-run (no --apply) is plan-only: force the module's own dry-run mode via
// the env flag AND open the database read-only, so a plan can never delete
// even if the module's semantics change.
if (!flag("apply")) process.env[ "ROOM_RETENTION_ALLOW_DELETION" ] = "0";
const db = new DatabaseSync(dbPath, { readOnly: !flag("apply") });
try {
  const known = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(spec.table);
  if (!known) usage(`refusing: table ${spec.table} not present — not a recognized room database`);
} catch (error) {
  usage(`refusing: could not inspect schema: ${error?.message ?? String(error)}`);
}

const store = {
  db,
  transaction: fn => {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  },
};

const receipts = [];
let receipt;
try {
  receipt = runLiveStoreRetention({
    store,
    env: process.env,
    now: nowOpt ?? undefined,
    limit,
    tableIndex,
    record: r => receipts.push(r),
  });
} catch (error) {
  console.error(`retention-plan: batch failed: ${error?.message ?? String(error)}`);
  process.exit(2);
} finally {
  db.close();
}

console.log(JSON.stringify({ ...receipt, recorded: receipts.length }, null, 2));
