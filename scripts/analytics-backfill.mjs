// Read-only backfill. Copies the tables the tail reads into memory, runs the
// tail there, and prints the baseline. The input file is never written.
// AN-1b schedules this shape of run; this script is the one-shot form.
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { baselineReport, ensureAnalyticsSchema, runAnalyticsTail } from "../server/analytics/index.mjs";

const TABLES = [
  "rooms", "events", "accounts", "member_accounts", "share_links", "guest_invites",
  "agent_invite_codes", "referral_invites", "membership_invitations", "agent_wake_signals",
  "wake_queue", "agent_work_wakes", "public_work_receipts", "referrals"
];

function copyTable(source, scratch, name) {
  const row = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!row?.sql) return false;
  scratch.exec(row.sql);
  const cols = source.prepare(`PRAGMA table_info(${name})`).all().map(col => col.name);
  const rows = source.prepare(`SELECT * FROM ${name}`).all();
  if (!rows.length || !cols.length) return true;
  const quoted = cols.map(col => `"${col.replaceAll('"', '""')}"`).join(",");
  const insert = scratch.prepare(`INSERT INTO ${name} (${quoted}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const record of rows) insert.run(...cols.map(col => record[col] ?? null));
  return true;
}

export async function backfillFile(dbPath, { now = Date.now() } = {}) {
  const source = new DatabaseSync(dbPath, { readOnly: true });
  source.exec("PRAGMA query_only=ON");
  const scratch = new DatabaseSync(":memory:");
  scratch.exec("PRAGMA foreign_keys=OFF");
  try {
    for (const name of TABLES) copyTable(source, scratch, name);
  } finally {
    source.close();
  }
  ensureAnalyticsSchema(scratch);
  let guard = 0;
  let tail;
  do {
    tail = await runAnalyticsTail(scratch, { budgetMs: 60_000, batch: 500, now });
    guard += 1;
    if (tail.errors) throw new Error("analytics tail failed during backfill");
  } while (!tail.done && guard < 10000);
  if (!tail.done) throw new Error("analytics backfill did not finish");
  const report = baselineReport(scratch, { now });
  scratch.close();
  return { report, tail };
}

function parseArgs(argv) {
  let db = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--db") db = argv[i + 1] ?? null;
    else if (argv[i] === "--report") continue;
    else if (argv[i].startsWith("-")) throw new Error(`unknown argument ${argv[i]}`);
  }
  return db;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let db;
  try { db = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (!db) {
    console.error("usage: node scripts/analytics-backfill.mjs --db <sqlite> [--report]");
    process.exit(1);
  }
  backfillFile(db).then(({ report }) => {
    console.log(JSON.stringify(report, null, 2));
  }).catch(error => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}
