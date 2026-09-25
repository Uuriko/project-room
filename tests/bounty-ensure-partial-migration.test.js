// Regression: BountyEscrow._ensure() must converge BOTH missing tables and
// older columns on a partially-migrated shard.
//
// Production incident 2026-09-22 (post-#792): propose 500'd with
// "table bounty_records has no column named rubric_json" consistently in
// SOME rooms while reads (snapshot, bounties list, balances, history) kept
// working. Root cause: _ensure() treated "some tables missing" and "columns
// need migrating" as either/or —
//   if (needed.some(t => !tables.has(t))) this.db.exec(bountyEscrowSchema);
//   else this._migrateColumns();
// A shard carrying the pre-#792 table set (no bounty_rubric_versions /
// bounty_flakes / bounty_review_packets / bounty_sybil_flags) but an old
// bounty_records (no rubric_json/rubric_hash/rubric_version) took the first
// branch: the new tables were created, the old columns were never added,
// and every propose INSERT then threw while SELECT-based reads worked.
// The fix runs _migrateColumns() unconditionally after creating tables.
//
// This test builds exactly that shard state (no RoomStore boot convergence —
// the request-time _ensure() fallback path) and requires propose to succeed.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, bountyEscrowSchema } from "../server/bounty-escrow.mjs";

const ROOM = "room-partial-shard";
const LANE = "id:agent/instinct";
let nowMs = 1_786_000_000_000;
const deadline = new Date(nowMs + 3_600_000).toISOString();

function makeStore(db) {
  const transaction = fn => {
    db.exec("SAVEPOINT partial_migration_test");
    try { const out = fn(); db.exec("RELEASE partial_migration_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO partial_migration_test"); db.exec("RELEASE partial_migration_test"); throw error; }
  };
  return { db, transaction, readTransaction: transaction };
}

const tablesOf = db => new Set(
  db.prepare("SELECT name AS n FROM sqlite_master WHERE type='table'").all().map(r => r.n));
const colsOf = (db, table) => new Set(
  db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));

// A shard as the pre-#792 build left it: the 7 original bounty tables with
// the old bounty_records column set (no rubric_*/submission_hash columns),
// none of the 5 slice-4/6/8/10 tables.
function makePartialShard() {
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  for (const t of ["bounty_rubric_versions", "bounty_flakes", "bounty_review_packets", "bounty_sybil_flags", "bounty_reputation_packets"])
    db.exec(`DROP TABLE ${t}`);
  for (const c of ["rubric_json", "rubric_hash", "rubric_version", "submission_hash"])
    db.exec(`ALTER TABLE bounty_records DROP COLUMN ${c}`);
  // A legacy bounty row, as a deployed shard would carry.
  db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, state, state_changed_ms,
     deadline_ms, created_at, updated_at)
    VALUES ('LEGACY-1', ?, 'legacy', 'legacy criteria', 1000, ?, 'proposed', ?, ?, datetime('now'), datetime('now'))`)
    .run(ROOM, LANE, nowMs, nowMs + 3_600_000);
  return db;
}

test("partially-migrated shard: first write converges tables AND columns, propose succeeds", () => {
  const db = makePartialShard();
  assert.ok(!tablesOf(db).has("bounty_rubric_versions"), "precondition: new table missing");
  assert.ok(!colsOf(db, "bounty_records").has("rubric_json"), "precondition: rubric column missing");

  const escrow = new BountyEscrow(makeStore(db), { now: () => nowMs, allowLegacyStringLanes: true });
  // Pre-fix this threw "table bounty_records has no column named rubric_json".
  const { bounty } = escrow.postBounty(ROOM,
    { poster: LANE, title: "T", criteria: "C", amount: 10, deadline });
  assert.ok(bounty.bountyId, "propose returns a bounty");

  // The shard is now fully converged.
  for (const t of ["bounty_rubric_versions", "bounty_flakes", "bounty_review_packets", "bounty_sybil_flags", "bounty_reputation_packets"])
    assert.ok(tablesOf(db).has(t), `table converged: ${t}`);
  for (const c of ["rubric_json", "rubric_hash", "rubric_version", "submission_hash"])
    assert.ok(colsOf(db, "bounty_records").has(c), `column converged: bounty_records.${c}`);

  // The new bounty pinned its rubric; the legacy row got its v1 backfill.
  const pins = db.prepare("SELECT bounty_id, version FROM bounty_rubric_versions WHERE room_id=? ORDER BY bounty_id")
    .all(ROOM);
  assert.deepEqual(pins.map(r => [r.bounty_id, r.version]),
    [["LEGACY-1", 1], [bounty.bountyId, 1]]);
  const legacy = db.prepare("SELECT rubric_json, rubric_hash, rubric_version FROM bounty_records WHERE bounty_id='LEGACY-1'").get();
  assert.equal(legacy.rubric_version, 1);
  assert.ok(legacy.rubric_json && legacy.rubric_hash, "legacy row backfilled");

  // Reads keep working alongside writes on the converged shard.
  const listed = escrow.listBounties(ROOM, {});
  assert.equal(listed.length, 2);
  const balances = escrow.balances(ROOM, LANE);
  assert.equal(balances.payable, 100);
  assert.ok(Array.isArray(escrow.history(ROOM, LANE)));
});

test("partially-migrated shard: repeated writes stay converged (no double migration)", () => {
  const db = makePartialShard();
  const escrow = new BountyEscrow(makeStore(db), { now: () => nowMs, allowLegacyStringLanes: true });
  const first = escrow.postBounty(ROOM, { poster: LANE, title: "A", criteria: "C", amount: 10, deadline }).bounty;
  const second = escrow.postBounty(ROOM, { poster: LANE, title: "B", criteria: "C", amount: 10, deadline }).bounty;
  assert.notEqual(first.bountyId, second.bountyId);
  assert.equal(escrow.listBounties(ROOM, {}).length, 3);
});
