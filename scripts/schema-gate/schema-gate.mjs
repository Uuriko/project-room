#!/usr/bin/env node
// Schema convergence gate — CI-time harness for the bounty-propose-500 bug class.
//
// Incident: post-#792 (2026-09-22), bounty propose 500'd with
// "table bounty_records has no column named rubric_json" consistently in SOME
// rooms while reads kept working. Root cause: BountyEscrow._ensure() treated
// "some tables missing" and "columns need migrating" as either/or:
//
//   if (needed.some(t => !tables.has(t))) this.db.exec(bountyEscrowSchema);
//   else this._migrateColumns();
//
// A shard carrying the pre-#792 table set (no bounty_rubric_versions /
// bounty_flakes / bounty_review_packets / bounty_sybil_flags) but an old
// bounty_records (no rubric_json/rubric_hash/rubric_version) took the first
// branch: the new tables were created, the old columns were never added, and
// every propose INSERT then threw. Fixed by #793 (run _migrateColumns()
// unconditionally after creating missing tables).
//
// The gate:
//   1. Builds simulated legacy shard databases (the incident state plus the
//      neighbouring partial-migration states).
//   2. Runs the CURRENT code's request-time _ensure()/migration path against
//      each one (the same fallback path a request takes when RoomStore boot
//      convergence never ran on that isolate).
//   3. FAILS (non-zero exit) if any request-path INSERT throws, or if the
//      migrated shard is missing any table/column the pristine schema
//      declares (a silently-skipped column migration).
//
// The convergence oracle is the schema DDL itself: for each legacy shard the
// harness also builds a fresh database from the exported bountyEscrowSchema
// and diffs tables+columns. That makes the gate future-proof — a new column
// added to the DDL that a future migration forgets to backfill fails the
// gate, with no hardcoded column list to keep in sync.
//
// Usage:
//   node scripts/schema-gate/schema-gate.mjs [--codebase <dir>] [--only <row>] [--list]
//   --codebase <dir>  Repo checkout whose server/bounty-escrow.mjs is tested.
//                     Default: this script's own repo. Point it at a pre-fix
//                     checkout (see README) for the negative control.
//   --only <row>      Run a single matrix row.
//   --list            List matrix rows and exit.
//
// Exit 0: every row passed. Exit 1: at least one row failed (report on stdout).
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const CODEBASE = flag("--codebase") ? path.resolve(flag("--codebase")) : REPO_ROOT;
const ONLY = flag("--only");
const LIST_ONLY = args.includes("--list");

const escrowUrl = pathToFileURL(path.join(CODEBASE, "server", "bounty-escrow.mjs")).href;
const { BountyEscrow, bountyEscrowSchema, defaultRubricFor } = await import(escrowUrl);

const ROOM = "room-schema-gate";
const LANE = "id:agent/gate";
const nowMs = 1_786_000_000_000; // pinned, matches the #793 regression test
const deadline = new Date(nowMs + 3_600_000).toISOString();

// Tables added after the pre-#792 schema (slices 6/8/10).
const NEW_TABLES = ["bounty_rubric_versions", "bounty_flakes", "bounty_review_packets", "bounty_sybil_flags"];
// Columns added by _migrateColumns() after the slice-1 schema (#762 shipped).
const MIGRATED_COLUMNS = {
  bounty_journal: ["actor_kind", "actor_id", "receipt_id", "track"],
  bounty_events: ["actor_kind", "before_state", "after_state", "track"],
  bounty_records: ["state_changed_ms", "snoozed_until_ms", "decline_reason", "duplicate_of", "label",
    "rubric_json", "rubric_hash", "rubric_version", "submission_hash"],
};

const tablesOf = db => new Set(
  db.prepare("SELECT name AS n FROM sqlite_master WHERE type='table'").all().map(r => r.n));
const colsOf = (db, table) => new Set(
  db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
const hasTable = (db, t) => tablesOf(db).has(t);
const hasCol = (db, t, c) => hasTable(db, t) && colsOf(db, t).has(c);

function snapshot(db) {
  const out = {};
  for (const t of tablesOf(db)) out[t] = [...colsOf(db, t)].sort();
  return out;
}

// The request-time _ensure() fallback path: direct (non-store) construction,
// the same shape the #793 regression test uses.
function makeStore(db) {
  const transaction = fn => {
    db.exec("SAVEPOINT schema_gate");
    try { const out = fn(); db.exec("RELEASE schema_gate"); return out; }
    catch (error) { db.exec("ROLLBACK TO schema_gate"); db.exec("RELEASE schema_gate"); throw error; }
  };
  return { db, transaction, readTransaction: transaction };
}

// Seed one legacy bounty row into whatever columns bounty_records currently
// has (dynamic: works against old and new column sets alike).
function seedLegacyRow(db, bountyId) {
  const info = db.prepare("PRAGMA table_info(bounty_records)").all();
  const names = info.map(c => c.name);
  const valueFor = c => {
    if (c.name === "bounty_id") return bountyId;
    if (c.name === "room_id") return ROOM;
    if (c.name === "title") return "legacy title";
    if (c.name === "criteria") return "legacy criteria";
    if (c.name === "poster") return LANE;
    if (c.name === "state") return "proposed";
    if (c.name === "created_at" || c.name === "updated_at") return new Date(nowMs).toISOString();
    if (c.name.endsWith("_json")) {
      // Readers JSON.parse these (rubric_json is .map'd as an array), so seed
      // realistic shapes: a real converged shard would carry pinned rubrics.
      if (c.name === "rubric_json") return JSON.stringify(defaultRubricFor("legacy criteria"));
      return "{}";
    }
    if (c.name === "rubric_hash") return "deadbeef".repeat(8);
    if (c.name === "rubric_version") return 1;
    if (/^is_|_ms$|_version$|amount_millis/.test(c.name) || c.type.toUpperCase().includes("INT")) {
      return c.name === "amount_millis" ? 1000 : nowMs;
    }
    return "legacy";
  };
  const vals = info.map(valueFor);
  db.prepare(`INSERT INTO bounty_records (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
    .run(...vals);
}

function dropTableIfExists(db, t) { if (hasTable(db, t)) db.exec(`DROP TABLE ${t}`); }
function dropColIfExists(db, t, c) { if (hasCol(db, t, c)) db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`); }

// ---- legacy shard matrix -------------------------------------------------
const MATRIX = [
  {
    name: "incident-792",
    describe: "pre-#792 shard: missing slice-6/8/10 tables AND pre-slice-6 bounty_records columns (the production incident state)",
    build(db) {
      db.exec(bountyEscrowSchema);
      for (const t of NEW_TABLES) dropTableIfExists(db, t);
      for (const c of ["rubric_json", "rubric_hash", "rubric_version", "submission_hash"])
        dropColIfExists(db, "bounty_records", c);
      seedLegacyRow(db, "LEGACY-792");
    },
    expectSeeded: true,
  },
  {
    name: "columns-stale",
    describe: "all tables present but every _migrateColumns() column missing (stale-columns-only shard)",
    build(db) {
      db.exec(bountyEscrowSchema);
      for (const [t, cols] of Object.entries(MIGRATED_COLUMNS))
        for (const c of cols) dropColIfExists(db, t, c);
      seedLegacyRow(db, "LEGACY-COLS");
    },
    expectSeeded: true,
  },
  {
    name: "tables-missing",
    describe: "converged columns but the 4 newer tables dropped (tables-only shard)",
    build(db) {
      db.exec(bountyEscrowSchema);
      for (const t of NEW_TABLES) dropTableIfExists(db, t);
      seedLegacyRow(db, "LEGACY-TABLES");
    },
    expectSeeded: true,
  },
  {
    name: "fresh",
    describe: "empty database (first-boot path; migration must be a safe no-op)",
    build() { /* nothing: _ensure() converges from zero */ },
    expectSeeded: false,
  },
];

if (LIST_ONLY) {
  for (const row of MATRIX) console.log(`${row.name}\t${row.describe}`);
  process.exit(0);
}
const rows = ONLY ? MATRIX.filter(r => r.name === ONLY) : MATRIX;
if (ONLY && rows.length === 0) {
  console.error(`unknown matrix row: ${ONLY} (use --list)`);
  process.exit(2);
}

const failures = [];

for (const row of rows) {
  const problems = [];
  let db;
  try {
    db = new DatabaseSync(":memory:");
    row.build(db);

    // Sanity preconditions for the incident row (the gate must actually be
    // testing the partial state, not a converged one).
    if (row.name === "incident-792") {
      if (hasTable(db, "bounty_rubric_versions"))
        problems.push("precondition broken: bounty_rubric_versions should be absent");
      if (hasCol(db, "bounty_records", "rubric_json"))
        problems.push("precondition broken: bounty_records.rubric_json should be absent");
    }

    // 1) Request-path INSERT must not 500. This is the exact throw the
    //    incident produced ("table bounty_records has no column named
    //    rubric_json") — the pre-#793 _ensure() never added the columns.
    const escrow = new BountyEscrow(makeStore(db), { now: () => nowMs, allowLegacyStringLanes: true });
    let bounty;
    try {
      ({ bounty } = escrow.postBounty(ROOM, {
        poster: LANE, title: "gate probe", criteria: "gate criteria", amount: 10, deadline,
      }));
    } catch (error) {
      problems.push(`request-path INSERT failed: ${error.message}`);
    }
    if (!problems.length && !bounty?.bountyId) problems.push("postBounty returned no bounty");

    // Reads must keep working alongside writes on the converged shard.
    if (!problems.length) {
      try {
        const listed = escrow.listBounties(ROOM, {});
        if (!Array.isArray(listed)) problems.push("listBounties did not return an array");
      } catch (error) {
        problems.push(`read path failed after write: ${error.message}`);
      }
    }

    // 2) No column migration may be silently skipped: diff the migrated
    //    shard against a pristine schema oracle built from the same DDL.
    const oracle = new DatabaseSync(":memory:");
    oracle.exec(bountyEscrowSchema);
    const want = snapshot(oracle);
    const got = snapshot(db);
    const missingTables = Object.keys(want).filter(t => !(t in got));
    const missingCols = [];
    for (const [t, cols] of Object.entries(want)) {
      if (!(t in got)) continue;
      const have = new Set(got[t]);
      for (const c of cols) if (!have.has(c)) missingCols.push(`${t}.${c}`);
    }
    oracle.close();
    if (missingTables.length) problems.push(`silently skipped table migration: ${missingTables.join(", ")}`);
    if (missingCols.length) problems.push(`silently skipped column migration: ${missingCols.join(", ")}`);

    // 3) Legacy rows must be backfilled, not left NULL (the rubric pin
    //    backfill is part of the migration contract).
    if (row.expectSeeded && !problems.length) {
      const legacy = db.prepare("SELECT rubric_version, rubric_json, rubric_hash FROM bounty_records WHERE bounty_id LIKE 'LEGACY-%'").get();
      if (legacy && (legacy.rubric_version == null || !legacy.rubric_json || !legacy.rubric_hash))
        problems.push("legacy row was not backfilled with its rubric pin");
    }
  } catch (error) {
    problems.push(`harness error: ${error.stack || error.message}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  if (problems.length) {
    failures.push(row.name);
    console.log(`FAIL ${row.name}`);
    for (const p of problems) console.log(`     - ${p}`);
  } else {
    console.log(`PASS ${row.name}`);
  }
}

console.log("");
if (failures.length) {
  console.log(`SCHEMA GATE: FAILED (${failures.length}/${rows.length} rows: ${failures.join(", ")})`);
  process.exit(1);
}
console.log(`SCHEMA GATE: PASSED (${rows.length}/${rows.length} rows) — codebase: ${CODEBASE}`);
