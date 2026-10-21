// Tests for the bounty_journal lot_state index (AUDIT-50X X-08 / M-4).
//
// Every balance SUM in the escrow (_balanceMillis, _requirePayable,
// _settleClaimBond's locked scan, _approvedMillis) filters on
// (room_id, account_id, lot_state). The journal's only account index was
// (room_id, account_id, seq), so each SUM scanned every journal row the
// account had ever had: a settlement's cost grew with the account's whole
// history inside a flat statement count. The additive index
// bounty_journal_lot_state (room_id, account_id, lot_state, seq) turns
// those scans into index searches. This suite pins:
//   1. a fresh database carries the index and passes verifySchema;
//   2. the exact _balanceMillis SUM plans as a SEARCH over the new index
//      (with a dropped-index negative control proving the plan assertion
//      can actually fail);
//   3. a pre-index database converges on both production paths — the
//      RoomStore boot convergence (convergeBountyDeployedSchema) and the
//      request-time direct-construction fallback (_ensure/_migrateColumns) —
//      with balances and journal contents unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, bountyEscrowSchema, convergeBountyDeployedSchema } from "../server/bounty-escrow.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";

const nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const indexSql = db => db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='index' AND name='bounty_journal_lot_state'").get()?.sql;
const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
// The exact _balanceMillis statement (server/bounty-escrow.mjs).
const BALANCE_SUM = "SELECT COALESCE(SUM(amount),0) AS total FROM bounty_journal WHERE room_id=? AND account_id=? AND lot_state=?";
const planOf = db => db.prepare(`EXPLAIN QUERY PLAN ${BALANCE_SUM}`)
  .all(ROOM, JILL, "payable").map(r => r.detail).join("\n");

function seedJournal(db, escrow) {
  // Real journal history through the public ops, plus bulk rows for a
  // second account so the planner has a journal worth scanning.
  const bounty = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  const insert = db.prepare(`INSERT INTO bounty_journal
    (room_id, entry_id, account_id, at, kind, bounty_id, lot_id, amount, lot_state, prev_hash, hash, memo, actor_kind, actor_id, track)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 300; i++)
    insert.run(ROOM, `ent_bulk_${i}`, GROK, new Date(nowMs).toISOString(), "transfer",
      null, null, 1, "payable", "h", `bulk_${i}`, null, null, null, null);
  return bounty;
}

test("fresh database carries the lot_state index and passes verifySchema", () => {
  const { escrow, db } = makeEscrow();
  assert.equal(normalize(indexSql(db)),
    normalize("CREATE INDEX bounty_journal_lot_state ON bounty_journal(room_id, account_id, lot_state, seq)"));
  assert.equal(escrow.verifySchema(), true);
});

test("the balance SUM plans as a SEARCH over the lot_state index, not a journal scan", () => {
  const { escrow, db } = makeEscrow();
  seedJournal(db, escrow);
  const withIndex = planOf(db);
  assert.match(withIndex, /SEARCH bounty_journal USING INDEX bounty_journal_lot_state/,
    `expected the lot_state index to serve the balance SUM, plan was: ${withIndex}`);
  // Negative control: without the index the same query cannot use it.
  db.exec("DROP INDEX bounty_journal_lot_state");
  const without = planOf(db);
  assert.doesNotMatch(without, /bounty_journal_lot_state/);
  // And the balances themselves are the index-independent truth.
  db.exec("CREATE INDEX IF NOT EXISTS bounty_journal_lot_state ON bounty_journal(room_id, account_id, lot_state, seq)");
  const b = escrow.balances(ROOM, JILL);
  assert.deepEqual(
    { payable: b.payable, locked: b.locked, attributed: b.attributed, approved: b.approved, total: b.total },
    { payable: 90, locked: 10, attributed: 0, approved: 0, total: 100 });
});

test("a pre-index database converges via the boot path, contents unchanged", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  db.exec("DROP INDEX bounty_journal_lot_state"); // the pre-index deployed shape
  assert.equal(indexSql(db), undefined);
  const { escrow } = makeEscrow(db);
  seedJournal(db, escrow);
  const journalBefore = db.prepare("SELECT COUNT(*) AS n FROM bounty_journal").get().n;
  const balanceBefore = escrow.balances(ROOM, JILL);

  db.exec("DROP INDEX bounty_journal_lot_state");
  convergeBountyDeployedSchema(db);
  assert.ok(indexSql(db), "boot convergence recreated the index");
  assert.equal(escrow.verifySchema(), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bounty_journal").get().n, journalBefore);
  const pick = x => ({ payable: x.payable, locked: x.locked, attributed: x.attributed, approved: x.approved, total: x.total });
  assert.deepEqual(pick(escrow.balances(ROOM, JILL)), pick(balanceBefore));
});

test("a pre-index database converges via direct construction (_ensure fallback)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  db.exec("DROP INDEX bounty_journal_lot_state");
  // Direct (non-store) construction: the first write op runs _ensure(),
  // whose _migrateColumns() must exec the index chunk — the RoomStore boot
  // convergence never runs on this path.
  const { escrow } = makeEscrow(db);
  escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 1, deadline: isoFuture(3_600_000) });
  assert.ok(indexSql(db), "the _ensure/_migrateColumns fallback recreated the index");
  assert.equal(escrow.verifySchema(), true);
});
