// Thread-split records for the quarantine review UI. When the owner
// "splits" a held quarantine item, the held message's imported source is
// detached from its thread so the rest of the conversation stays grouped
// without the held message; the quarantine row itself keeps its review
// state (split is a thread action, not a review verdict — a split held item
// still needs Confirm or Dismiss).
//
// Purely additive, like spam_quarantine and the stitch tables: no schema
// version bump, no writer-fence impact — a pre-split writer has no code
// path to this table, and the review lifecycle's held→released|dismissed
// rules plus the one-split-per-quarantine rule are the integrity gate. One
// split per quarantine id (a second split is a 409); splits are never edited
// or deleted, only read by the thread view (a read-path override that forces
// the split source into its own thread) and listed on the review surface.
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
export const quarantineSplitLimits = Object.freeze({ accountIdChars: 256, sourceIdChars: 512,
  threadChars: 1024, reviewerChars: 256, reasonChars: 256 });
export const quarantineThreadSplitSchema = `
  CREATE TABLE IF NOT EXISTS quarantine_thread_splits (
    quarantine_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source_id TEXT NOT NULL,
    prior_thread TEXT NOT NULL, reviewer TEXT NOT NULL, reason TEXT, split_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS quarantine_thread_splits_source ON quarantine_thread_splits(account_id, source_id);
`;
const view = row => ({ quarantineId: row.quarantine_id, accountId: row.account_id, sourceId: row.source_id,
  priorThread: row.prior_thread, reviewer: row.reviewer, reason: row.reason, splitAt: row.split_at });
const textOf = (value, limit, field) => {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) fail(422, "invalid_quarantine_split", `${field} must be a 1..${limit} character string`);
  return value;
};

export class QuarantineThreadSplits {
  constructor(store) { this.store = store; this.db = store.db; }
  // A read-only open of a file written before this journal finds none of
  // these objects and must not migrate, so allowAbsent accepts a wholly
  // missing schema; a partially present one still fails.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = quarantineThreadSplitSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Quarantine thread-split journal schema requires operator reconciliation");
    }
    return true;
  }
  // Offline integrity: every split names its quarantine row, account, and
  // source, the thread it was separated from, its reviewer, and its time.
  // A quarantine id splits at most once (the table's PRIMARY KEY).
  verify() {
    return this.store.readTransaction(() => {
      let splits = 0;
      for (const row of this.db.prepare("SELECT * FROM quarantine_thread_splits").all()) {
        if (!/^qz-[1-9][0-9]*$/.test(row.quarantine_id) || row.account_id.length === 0 || row.account_id.length > quarantineSplitLimits.accountIdChars
          || row.source_id.length === 0 || row.source_id.length > quarantineSplitLimits.sourceIdChars
          || row.prior_thread.length === 0 || row.prior_thread.length > quarantineSplitLimits.threadChars
          || row.reviewer.length === 0 || row.reviewer.length > quarantineSplitLimits.reviewerChars
          || !Number.isInteger(row.split_at) || row.split_at <= 0
          || (row.reason !== null && (typeof row.reason !== "string" || row.reason.length > quarantineSplitLimits.reasonChars)))
          throw new Error("Quarantine thread-split journal requires operator reconciliation");
        splits++;
      }
      return { splits, checkedAt: this.store.now() };
    });
  }
  // Record the owner's split of one held quarantine item off its thread.
  // priorThread is the thread id the source was separated from, captured at
  // split time for the audit trail. One split per quarantine id: a second
  // split of the same quarantine row is a 409.
  split({ accountId, quarantineId, sourceId, priorThread, reviewer, reason = null }) {
    textOf(accountId, quarantineSplitLimits.accountIdChars, "accountId");
    if (!/^qz-[1-9][0-9]*$/.test(quarantineId)) fail(422, "invalid_quarantine_split", "quarantineId must be a qz-<n> quarantine id");
    textOf(sourceId, quarantineSplitLimits.sourceIdChars, "sourceId");
    textOf(priorThread, quarantineSplitLimits.threadChars, "priorThread");
    textOf(reviewer, quarantineSplitLimits.reviewerChars, "reviewer");
    if (reason !== null && (typeof reason !== "string" || reason.length === 0 || reason.length > quarantineSplitLimits.reasonChars))
      fail(422, "invalid_quarantine_split", `reason must be a 1..${quarantineSplitLimits.reasonChars} character string`);
    return this.store.transaction(() => {
      const now = this.store.now();
      try {
        this.db.prepare("INSERT INTO quarantine_thread_splits (quarantine_id,account_id,source_id,prior_thread,reviewer,reason,split_at) VALUES(?,?,?,?,?,?,?)")
          .run(quarantineId, accountId, sourceId, priorThread, reviewer, reason, now);
      } catch (error) {
        // better-sqlite3 surfaces constraint violations as generic errors;
        // match the message narrowly like the rest of the store does.
        if (/UNIQUE constraint failed: quarantine_thread_splits/.test(error?.message ?? ""))
          fail(409, "quarantine_already_split", `quarantine "${quarantineId}" is already split off its thread`);
        throw error;
      }
      return view(this.db.prepare("SELECT * FROM quarantine_thread_splits WHERE quarantine_id=?").get(quarantineId));
    });
  }
  // The split record for one quarantine id, or null.
  forQuarantine(quarantineId) {
    if (typeof quarantineId !== "string") fail(422, "invalid_quarantine_split", "quarantineId must be a string");
    return this.store.readTransaction(() => {
      const row = this.db.prepare("SELECT * FROM quarantine_thread_splits WHERE quarantine_id=?").get(quarantineId);
      return row ? view(row) : null;
    });
  }
  // All split records for one account, oldest first.
  list(accountId) {
    if (typeof accountId !== "string" || accountId.length === 0) fail(422, "invalid_quarantine_split", "accountId must be a non-empty string");
    return this.store.readTransaction(() => this.db
      .prepare("SELECT * FROM quarantine_thread_splits WHERE account_id=? ORDER BY split_at").all(accountId).map(view));
  }
  // Source ids the account's owner has split off their threads. The thread
  // view reads this set and forces those sources into singleton threads.
  splitSourceIds(accountId) {
    if (typeof accountId !== "string" || accountId.length === 0) fail(422, "invalid_quarantine_split", "accountId must be a non-empty string");
    return this.store.readTransaction(() => new Set(
      this.db.prepare("SELECT source_id FROM quarantine_thread_splits WHERE account_id=?").all(accountId).map(row => row.source_id)));
  }
}
