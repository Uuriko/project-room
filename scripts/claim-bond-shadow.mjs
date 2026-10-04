// claim-bond-shadow: P0 shadow-mode reporter for claim bonds.
//
// Usage:
//   node scripts/claim-bond-shadow.mjs --db <path-to-room.sqlite> [--room <roomId>] [--sync]
//
// Without --sync this is strictly read-only (PRAGMA query_only=ON) and
// reports the baseline flake rate from the claim_bond_shadow journal.
// With --sync it first replays work_claim.updated events into the journal
// (idempotent; writes only its own additive table, outside the writer fence).
//
// Exit 0 with a JSON report on stdout. Exit 2 on bad arguments, exit 1 when
// the database cannot answer, with the reason on stderr.
import { DatabaseSync } from "node:sqlite";
import { SHADOW_KINDS, shadowReport, syncShadowJournal } from "../server/analytics/claim-bond-shadow.mjs";

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
    console.error(`claim-bond-shadow: ${error.message}`);
    process.exit(2);
  }
  let db;
  try {
    db = new DatabaseSync(args.db, { readOnly: !args.sync });
  } catch (error) {
    console.error(`claim-bond-shadow: cannot open db: ${error.message}`);
    process.exit(1);
  }
  try {
    if (!args.sync) db.exec("PRAGMA query_only=ON");
    let syncResult = null;
    if (args.sync) syncResult = syncShadowJournal(db, { roomId: args.room });
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='claim_bond_shadow'").get();
    const report = {
      generatedAt: new Date().toISOString(),
      db: args.db,
      room: args.room,
      synced: args.sync,
      sync: syncResult,
      journalPresent: Boolean(table),
      kinds: [...SHADOW_KINDS],
      baseline: table ? shadowReport(db, { roomId: args.room }) : null,
      interpretation: "P0 decision gate: verdict=concentrated -> build P1 (reputation-cost bonds). " +
        "verdict=dispersed -> flakes are ambient; bonds solve the wrong problem; stop. " +
        "verdict=insufficient_data -> keep observing."
    };
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`claim-bond-shadow: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
