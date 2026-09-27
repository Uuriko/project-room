// bounty-conservation-check.mjs — scheduled read-only verifier for the
// bounty-escrow hash chain / conservation invariant.
//
// Phase-1 research confirmed BountyEscrow.verifyConservation
// (server/bounty-escrow.mjs) is the ONLY verifier for the bounty-escrow hash
// chain and conservation invariant, and it has ZERO production callers: the
// chain's tamper-evidence is write-only — cost on every append, benefit never
// realized. This script wires the benefit back in: it opens the room database
// strictly read-only, runs verifyConservation across every room, and emits a
// machine-readable report.
//
// Read-only guarantees (no write locks on production data):
//   1. The database handle opens with node:sqlite { readOnly: true } —
//      writes are refused at the driver level, not by convention.
//   2. db.readOnlyTransaction is set before touching BountyEscrow, so its
//      _ensure() takes the schema-presence-only path and never migrates.
//   3. verifyConservation itself runs inside readTransaction and issues only
//      SELECTs (plus PRAGMA table_info reads).
//
// Usage:
//   node scripts/bounty-conservation-check.mjs --db /path/to/room.sqlite
//   node scripts/bounty-conservation-check.mjs            # uses $ROOM_DB
//
// Exit codes:
//   0 — every room verified, no violations (JSON report on stdout).
//   1 — one or more conservation violations (JSON report on stdout).
//   2 — environment/usage error: missing --db, unreadable file, not a room
//       database, or the bounty-escrow schema is absent (nothing to verify).
//       This is a check failure, not a conservation violation.
import { parseArgs } from "node:util";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

process.umask(0o077);

const TOOL = "bounty-conservation-check";

function usage() {
  return `usage: node scripts/bounty-conservation-check.mjs --db <room.sqlite>\n` +
    `       (falls back to $ROOM_DB)\n\n` +
    `Opens the room database read-only and runs BountyEscrow.verifyConservation\n` +
    `across every room. Exit 0 = clean, 1 = violations, 2 = environment error.`;
}

function failEnv(message) {
  process.stderr.write(`${TOOL}: environment error: ${message}\n${usage()}\n`);
  process.exit(2);
}

// --- argument handling -------------------------------------------------------
let values;
try {
  ({ values } = parseArgs({
    options: {
      db: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (error) {
  failEnv(error.message);
}
if (values.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
const dbPath = values.db || process.env.ROOM_DB;
if (!dbPath) failEnv("no database path: pass --db or set ROOM_DB");
const resolved = resolve(dbPath);
try {
  if (!statSync(resolved).isFile()) failEnv(`not a file: ${resolved}`);
} catch (error) {
  if (error?.code === "ENOENT") failEnv(`database not found: ${resolved}`);
  failEnv(`cannot stat ${resolved}: ${error.message}`);
}

// --- read-only open ----------------------------------------------------------
// Driver-level read-only: any attempted write throws
// "attempt to write a readonly database". SHARED locks only — no write
// locks are ever taken on the production file.
let db;
try {
  db = new DatabaseSync(resolved, { readOnly: true });
} catch (error) {
  failEnv(`cannot open read-only: ${error.message}`);
}
// Mark the handle so BountyEscrow._ensure() takes its read-only path
// (schema presence verification only; it never migrates). Mirrors
// cloudflare/storage.mjs, which sets the same flag inside transactions.
db.readOnlyTransaction = true;

// Minimal store double: verifyConservation wraps everything in
// readTransaction and issues only SELECTs, so a plain passthrough is safe
// on a read-only handle.
const store = { db, transaction: fn => fn(), readTransaction: fn => fn() };
const escrow = new BountyEscrow(store, { now: () => Date.now() });

// The rooms table is the room-store's own; its absence means this file is
// not a room database at all.
try {
  db.prepare("SELECT 1 FROM rooms LIMIT 1").get();
} catch (error) {
  db.close();
  failEnv(`not a room database (${resolved}): ${error.message}`);
}

// Absent escrow schema is a deployment state, not a conservation violation:
// exit 2 so the operator notices, instead of silently reporting "clean" on
// a file that has nothing to verify.
let hasEscrow;
try {
  hasEscrow = escrow.verifySchema({ allowAbsent: true });
} catch (error) {
  db.close();
  failEnv(`bounty escrow schema requires operator reconciliation: ${error.message}`);
}
if (!hasEscrow) {
  db.close();
  failEnv(`bounty escrow schema absent in ${resolved}: nothing to verify`);
}

// --- verify every room -------------------------------------------------------
const roomIds = db.prepare("SELECT id FROM rooms ORDER BY id").all().map(r => r.id);
const rooms = [];
const violations = [];
for (const roomId of roomIds) {
  let result;
  try {
    result = escrow.verifyConservation(roomId);
  } catch (error) {
    db.close();
    failEnv(`verifyConservation threw for room ${roomId}: ${error.message}`);
  }
  rooms.push({
    roomId,
    ok: result.ok,
    violations: result.violations,
    totalIssued: result.totalIssued,
    byState: result.byState,
  });
  for (const v of result.violations) violations.push({ roomId, violation: v });
}
db.close();

const report = {
  tool: TOOL,
  checkedAt: new Date().toISOString(),
  db: resolved,
  roomsChecked: roomIds.length,
  ok: violations.length === 0,
  violations,
  rooms,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.ok) {
  process.stderr.write(`${TOOL}: OK — ${roomIds.length} room(s) verified, no conservation violations\n`);
  process.exit(0);
}
process.stderr.write(`${TOOL}: VIOLATIONS — ${violations.length} violation(s) in ` +
  `${new Set(violations.map(v => v.roomId)).size} room(s):\n`);
for (const v of violations.slice(0, 10))
  process.stderr.write(`  [${v.roomId}] ${v.violation}\n`);
if (violations.length > 10)
  process.stderr.write(`  ... and ${violations.length - 10} more (see JSON report)\n`);
process.exit(1);
