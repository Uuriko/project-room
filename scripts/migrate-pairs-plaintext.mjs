#!/usr/bin/env node
// Operator entry point for the pairs plaintext backfill
// (server/pairs-backfill.mjs). Run once against a room database file,
// only after the hash-on-write fix (PR 5517) is deployed, and again
// later if the first run reports deferredLive rows whose replay
// windows have since passed. Idempotent: a re-run over migrated rows
// changes nothing.
//
//   node scripts/migrate-pairs-plaintext.mjs <room-db-path> [--now <ms>]
//
// Prints a JSON report of pair ids and counts only - never a stored
// credential value. Skipped (malformed) rows are also logged to stderr
// by id as they are passed over.
import { DatabaseSync } from "node:sqlite";
import { migratePairsPlaintext } from "../server/pairs-backfill.mjs";

const [dbPath, ...rest] = process.argv.slice(2);
if (!dbPath) {
  console.error("usage: node scripts/migrate-pairs-plaintext.mjs <room-db-path> [--now <ms>]");
  process.exit(2);
}
let now = Date.now();
const nowIdx = rest.indexOf("--now");
if (nowIdx !== -1) {
  now = Number(rest[nowIdx + 1]);
  if (!Number.isFinite(now)) {
    console.error("--now must be a millisecond timestamp");
    process.exit(2);
  }
}

const db = new DatabaseSync(dbPath);
try {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pairs'").get();
  if (!table) {
    console.error(`no pairs table in ${dbPath}`);
    process.exit(2);
  }
  const report = migratePairsPlaintext(db, {
    now,
    log: entry => console.error(`skipped pair ${entry.pairId}: ${entry.reason}`)
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
