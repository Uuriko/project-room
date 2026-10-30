// Scheduled conservation audit for the bounty escrow journal (#4125).
//
// Balances in BountyEscrow are DERIVED from bounty_journal by summation —
// the journal is not evidence about the money, it IS the money — yet until
// this job existed its only verifier (verifyConservation) had no production
// caller: the operator script scripts/bounty-conservation-check.mjs ran it
// by hand or not at all. A flipped amount was caught only if someone ran
// the script; a forged or double-appended settlement pair (valid hashes,
// valid chain, wrong money) was caught by nothing, because the audit's
// per-bounty checks reconciled only the escrow buckets — verifyConservation
// now reconciles the payable flows too, and this module is its caller.
//
// One pass audits every room with escrow activity (a journal row or a
// bounty record), read-only: verifyConservation runs inside a read
// transaction and issues only SELECTs; the audit never mutates the
// journal. Cost is O(journal) per room, so the registry runs it as a slow
// hourly job; the pass checks the cooperative deadline between rooms and
// reports budgetExceeded with the rooms it did audit as progress.
import { BountyEscrow } from "./bounty-escrow.mjs";

function query(store, sql, params = []) {
  if (!store?.db?.prepare) return null;
  try { return store.db.prepare(sql).all(...params); }
  catch { return null; } // a store that has never run escrow has no tables
}

// True when the store holds any escrow activity worth auditing. The job
// stays disabled (its resting state) until the first bounty exists.
export function escrowActivityPresent(store) {
  if (!store?.db?.prepare) return false;
  const journal = query(store, "SELECT 1 AS hit FROM bounty_journal LIMIT 1");
  if (journal?.length) return true;
  const records = query(store, "SELECT 1 AS hit FROM bounty_records LIMIT 1");
  return Boolean(records?.length);
}

// Rooms with escrow activity: any room the journal or the records name.
// (A records-only room — all bounties still proposed — audits clean and
// cheap; a journal-only room cannot exist, but the union costs nothing.)
export function escrowAuditRooms(store) {
  const rows = query(store, `SELECT room_id FROM (
      SELECT DISTINCT room_id FROM bounty_journal
      UNION SELECT DISTINCT room_id FROM bounty_records
    ) ORDER BY room_id`);
  return rows ? rows.map(r => r.room_id) : [];
}

// One audit pass. Returns the job summary (numbers/booleans only, like
// every heartbeat summary):
// - rooms:      rooms audited this pass;
// - violations: total conservation violations found;
// - errors:     rooms whose audit failed (violations found, or the audit
//               itself threw) — the heartbeat grades the tick failed, the
//               integrity-job precedent, so a money-ledger anomaly can
//               never read as a silent pass;
// - budgetExceeded: 1 when the deadline stopped the pass early (rooms
//               audited so far still count as progress).
// The failing rooms and their first violation go to the operator log
// (console), never the public summary: violation text names bounties and
// amounts. The summary carries failureDetail { code } only.
export function runEscrowConservationAudit(store, { deadline = null, escrow = null } = {}) {
  const summary = { rooms: 0, violations: 0, errors: 0 };
  if (!store?.db?.prepare) return summary;
  const instance = escrow
    ?? (store.bountyEscrow instanceof BountyEscrow ? store.bountyEscrow : new BountyEscrow(store));
  for (const roomId of escrowAuditRooms(store)) {
    if (deadline != null && summary.rooms > 0 && Date.now() > deadline) {
      summary.budgetExceeded = 1;
      break;
    }
    let result = null;
    try {
      result = instance.verifyConservation(roomId);
    } catch (error) {
      summary.rooms += 1;
      summary.errors += 1;
      summary.violations += 1;
      console.error(`[escrow-conservation] audit threw for room ${roomId}: ${String(error?.message ?? error).replace(/[\r\n]+/g, " ").slice(0, 200)}`);
      continue;
    }
    summary.rooms += 1;
    if (!result.ok) {
      summary.errors += 1;
      summary.violations += result.violations.length;
      console.error(`[escrow-conservation] room ${roomId}: ${result.violations.length} conservation violation(s); first: ${result.violations[0]}`);
    }
  }
  if (summary.errors > 0) summary.failureDetail = { code: "conservation_violation" };
  return summary;
}
