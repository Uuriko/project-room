// claim-reputation-sync: P1 claim-reputation journal tool.
//
// Usage:
//   node scripts/claim-reputation-sync.mjs --db <path-to-room.sqlite> [--room <roomId>] [--sync]
//
// Without --sync this is strictly read-only (PRAGMA query_only=ON) and
// reports the P1 signal counts from the claim_reputation_signals journal.
// With --sync it first replays work_claim.updated events into the journal
// (idempotent; writes only its own additive table, outside the writer fence).
//
// The weekly P1 measurement (CLAIMBONDS-P1-SPEC-2026-10-05.md) re-runs the
// P0 shadow baseline and diffs against 2026-10-05; this script populates the
// journal that measurement reads.
//
// Exit 0 with a JSON report on stdout. Exit 2 on bad arguments, exit 1 when
// the database cannot answer, with the reason on stderr.
//
// This script is the reachability entry point for server/claim-reputation.mjs
// (same standing as scripts/claim-bond-shadow.mjs for the P0 module). Live
// wiring into the analytics tail stays analytics-lane owned; this tool runs
// on demand, not from any request path.
import { DatabaseSync } from "node:sqlite";
import {
  CLAIM_REPUTATION_SIGNAL_TYPES,
  HOARDING_CAP,
  syncClaimReputationJournal
} from "../server/claim-reputation.mjs";

function parseArgs(argv) {
  let db = null;
  let room = null;
  let sync = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") { db = argv[i + 1] ?? null; i += 1; }
    else if (arg === "--room") { room = argv[i + 1] ?? null; i += 1; }
    else if (arg === "--sync") { sync = true; }
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!db) throw new Error("missing required --db <path>");
  return { db, room, sync };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`claim-reputation-sync: ${error.message}`);
    process.exit(2);
  }
  let db;
  try {
    db = new DatabaseSync(args.db, { readOnly: !args.sync });
  } catch (error) {
    console.error(`claim-reputation-sync: cannot open db: ${error.message}`);
    process.exit(1);
  }
  try {
    if (!args.sync) db.exec("PRAGMA query_only=ON");
    let syncResult = null;
    if (args.sync) syncResult = syncClaimReputationJournal(db, { roomId: args.room });
    const roomFilter = args.room ? "AND room_id=?" : "";
    const roomArgs = args.room ? [args.room] : [];
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='claim_reputation_signals'").get();
    let byKind = null;
    let topHoarders = null;
    if (table) {
      byKind = db.prepare(
        `SELECT kind, COUNT(*) AS signals, COUNT(DISTINCT agent_id) AS agents
         FROM claim_reputation_signals WHERE 1=1 ${roomFilter}
         GROUP BY kind ORDER BY kind`
      ).all(...roomArgs);
      topHoarders = db.prepare(
        `SELECT agent_id AS agentId, COUNT(*) AS hoarded
         FROM claim_reputation_signals WHERE kind='claim_hoarded' ${roomFilter}
         GROUP BY agent_id ORDER BY hoarded DESC LIMIT 10`
      ).all(...roomArgs);
    }
    const report = {
      generatedAt: new Date().toISOString(),
      db: args.db,
      room: args.room,
      synced: args.sync,
      sync: syncResult,
      journalPresent: Boolean(table),
      hoardingCap: HOARDING_CAP,
      signalTypes: [...CLAIM_REPUTATION_SIGNAL_TYPES],
      byKind,
      topHoarders,
      interpretation: "P1 measurement: diff byKind/topHoarders against the 2026-10-05 baseline " +
        "(59 claim_hoarded, all in 3 lanes). Falsifier: P0 flake rate above 15% for 2 consecutive " +
        "weekly runs -> the surcharge is mis-priced; re-spec, don't tune weights blindly."
    };
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`claim-reputation-sync: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
