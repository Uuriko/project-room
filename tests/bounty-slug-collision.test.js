// Regression: cross-room bounty-id slug collision must not 500.
//
// Production incident 2026-09-23: bounty_records.bounty_id is a GLOBAL
// primary key, but _nextBountyId keyed the per-id sequence by room_id while
// minting `${roomSlug(roomId)}-${n}` — and roomSlug truncates to 12
// alphanumeric characters. Two rooms whose slugs collide (e.g.
// instinct-bp-1790125051 and instinct-bp-1790153495 both slug to
// INSTINCTBP17) each started their own counter at 1, so the second room's
// EVERY propose died with "UNIQUE constraint failed: bounty_records.bounty_id"
// (HTTP 500 internal_error). Retries never healed: the per-room sequence
// rolled back with the failed transaction. Reads kept working, which is why
// it looked like the #793 schema poison at first.
//
// The repair keys the sequence by slug (shared counter for colliding slugs).
// These tests pin: (1) colliding rooms both propose successfully with a
// shared counter, (2) the data migration heals a pre-repair database in
// place through the request-time _ensure() fallback path, (3) the migration
// is idempotent, (4) a minted row without a sequence row never lets the
// counter rewind.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, bountyEscrowSchema, migrateBountySequencesToSlugKey } from "../server/bounty-escrow.mjs";

const LANE = "id:agent/jill";
let nowMs = 1_786_000_000_000;
const deadline = () => new Date(nowMs + 3_600_000).toISOString();

// Room ids chosen so the 12-char slugs collide, like the production pair.
const ROOM_A = "jill-bp-17901664321770"; // slug JILLBP179016
const ROOM_B = "jill-bp-17901664321771"; // slug JILLBP179016
const ROOM_C = "other-room-1";           // slug OTHERROOM1 (distinct)

function makeStore(db) {
  const transaction = fn => {
    db.exec("SAVEPOINT slug_collision_test");
    try { const out = fn(); db.exec("RELEASE slug_collision_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO slug_collision_test"); db.exec("RELEASE slug_collision_test"); throw error; }
  };
  return { db, transaction, readTransaction: transaction, now: () => nowMs };
}

const propose = (escrow, roomId, title = "t") =>
  escrow.postBounty(roomId, { poster: LANE, title, criteria: "criteria", amount: 5, deadline: deadline() });

test("colliding slugs: both rooms propose successfully on a shared counter", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  const escrow = new BountyEscrow(makeStore(db));
  const a = propose(escrow, ROOM_A);
  assert.equal(a.bounty.bountyId, "JILLBP179016-1");
  // Pre-repair this threw UNIQUE constraint failed: bounty_records.bounty_id.
  const b = propose(escrow, ROOM_B);
  assert.equal(b.bounty.bountyId, "JILLBP179016-2");
  const a2 = propose(escrow, ROOM_A, "t2");
  assert.equal(a2.bounty.bountyId, "JILLBP179016-3");
  // A distinct slug is unaffected: its own counter starts at 1.
  const c = propose(escrow, ROOM_C);
  assert.equal(c.bounty.bountyId, "OTHERROOM1-1");
});

test("migration heals a pre-repair database through the _ensure() fallback path", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  // Pre-repair state: sequences keyed by room_id, room A already minted -1.
  db.prepare("INSERT INTO bounty_sequences (room_id, next_n) VALUES (?, ?)").run(ROOM_A, 2);
  db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, state, state_changed_ms,
     deadline_ms, created_at, updated_at)
    VALUES ('JILLBP179016-1', ?, 't', 'criteria', 5000, ?, 'proposed', ?, ?, datetime('now'), datetime('now'))`)
    .run(ROOM_A, LANE, nowMs, nowMs + 3_600_000);
  const escrow = new BountyEscrow(makeStore(db)); // direct construction: no RoomStore boot convergence
  const b = propose(escrow, ROOM_B); // must not 500
  assert.equal(b.bounty.bountyId, "JILLBP179016-2");
  // Sequence table is now slug-keyed with the merged counter.
  const seqs = db.prepare("SELECT room_id AS k, next_n AS n FROM bounty_sequences ORDER BY k").all().map(r => ({ k: r.k, n: r.n }));
  assert.deepEqual(seqs, [{ k: "JILLBP179016", n: 3 }]);
});

test("migration is idempotent and leaves converged databases alone", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  db.prepare("INSERT INTO bounty_sequences (room_id, next_n) VALUES (?, ?)").run("JILLBP179016", 4);
  db.prepare("INSERT INTO bounty_sequences (room_id, next_n) VALUES (?, ?)").run("OTHERROOM1", 2);
  migrateBountySequencesToSlugKey(db);
  migrateBountySequencesToSlugKey(db);
  const seqs = db.prepare("SELECT room_id AS k, next_n AS n FROM bounty_sequences ORDER BY k").all().map(r => ({ k: r.k, n: r.n }));
  assert.deepEqual(seqs, [{ k: "JILLBP179016", n: 4 }, { k: "OTHERROOM1", n: 2 }]);
});

test("migration merges colliding pre-repair rows by max counter", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  db.prepare("INSERT INTO bounty_sequences (room_id, next_n) VALUES (?, ?)").run(ROOM_A, 2);
  db.prepare("INSERT INTO bounty_sequences (room_id, next_n) VALUES (?, ?)").run(ROOM_B, 5);
  migrateBountySequencesToSlugKey(db);
  const seqs = db.prepare("SELECT room_id AS k, next_n AS n FROM bounty_sequences").all().map(r => ({ k: r.k, n: r.n }));
  assert.deepEqual(seqs, [{ k: "JILLBP179016", n: 5 }]);
});

test("migration never rewinds below a minted row without a sequence row", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  // A minted -7 with no sequence row at all (sequence lost / never written).
  db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, state, state_changed_ms,
     deadline_ms, created_at, updated_at)
    VALUES ('JILLBP179016-7', ?, 't', 'criteria', 5000, ?, 'proposed', ?, ?, datetime('now'), datetime('now'))`)
    .run(ROOM_A, LANE, nowMs, nowMs + 3_600_000);
  const escrow = new BountyEscrow(makeStore(db));
  const b = propose(escrow, ROOM_B);
  assert.equal(b.bounty.bountyId, "JILLBP179016-8");
});
