// Durable quarantine journal for the spam guard (PR #554: the in-memory
// createQuarantineQueue in server/inbox-spam.mjs loses its queue on restart).
// Quarantined mail is never silently dropped: it lands here as a held record
// and stays until an owner releases it back to the inbox or dismisses it as
// spam. Every transition is recorded with the reviewer and a timestamp.
//
// Decision vocabulary mirrors the in-memory queue (release / confirm_spam) so
// the quarantine path can switch stores without rewording: confirm_spam maps
// to the dismissed status (the message stays out of the inbox).
//
// Purely additive, like wake_queue and pending_channel_updates: no schema
// version bump, no writer-fence impact, because a pre-journal writer has no
// code path to this table and the recovery audit's exact table list is the
// integrity gate. All writes go through the store transaction.
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
// reasonBytes caps the stored signal list (a flagMessage() result carries at
// most a handful of signals; the cap guards against pathological growth).
export const spamQuarantineLimits = Object.freeze({ reasonBytes: 8192, noteChars: 2048, batch: 500,
  messageIdChars: 512, channelChars: 128, connectionIdChars: 256, reviewerChars: 256 });
export const spamQuarantineStatuses = Object.freeze(["held", "released", "dismissed"]);
export const spamQuarantineDecisions = Object.freeze(["release", "confirm_spam"]);
export const spamQuarantineSchema = `
  CREATE TABLE IF NOT EXISTS spam_quarantine (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, channel TEXT NOT NULL, connection_id TEXT,
    reason TEXT NOT NULL CHECK(json_valid(reason)),
    score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
    quarantined_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('held','released','dismissed')),
    reviewed_by TEXT, reviewed_at INTEGER, note TEXT, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS spam_quarantine_held ON spam_quarantine(status, quarantined_at);
`;
const view = row => ({ id: row.id, messageId: row.message_id, channel: row.channel, connectionId: row.connection_id,
  reason: JSON.parse(row.reason), score: row.score, quarantinedAt: row.quarantined_at, status: row.status,
  reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, note: row.note, updatedAt: row.updated_at });
const textOf = (value, limit, field) => {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) fail(422, "invalid_quarantine", `${field} must be a 1..${limit} character string`);
  return value;
};
const flagOf = flag => {
  if (!flag || typeof flag !== "object" || Array.isArray(flag) || typeof flag.score !== "number"
    || !Number.isInteger(flag.score) || flag.score < 0 || flag.score > 100
    || !Array.isArray(flag.signals) || flag.quarantine !== true)
    fail(422, "invalid_quarantine", "flag must be a flagMessage() result with quarantine true");
  const reason = flag.signals.map(signal => {
    if (!signal || typeof signal !== "object" || typeof signal.key !== "string" || typeof signal.weight !== "number" || typeof signal.detail !== "string")
      fail(422, "invalid_quarantine", "flag signals must be {key, weight, detail}");
    return { key: signal.key, weight: signal.weight, detail: signal.detail };
  });
  if (Buffer.byteLength(JSON.stringify(reason)) > spamQuarantineLimits.reasonBytes)
    fail(422, "invalid_quarantine", "flag signals are too large to journal");
  return { reason, score: flag.score };
};

export class SpamQuarantineJournal {
  constructor(store) { this.store = store; this.db = store.db; }
  // A read-only open of a file written before this journal finds none of
  // these objects and must not migrate, so allowAbsent accepts a wholly missing
  // schema; a partially present one still fails.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = spamQuarantineSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Spam quarantine journal schema requires operator reconciliation");
    }
    return true;
  }
  // Offline integrity: every held row awaits review (no review fields), every
  // reviewed row names its reviewer and review time, the reason round-trips as
  // the flag's signal list, and reviewed rows are final (no status flips).
  verify() {
    return this.store.readTransaction(() => {
      const counts = { held: 0, released: 0, dismissed: 0 };
      for (const row of this.db.prepare("SELECT * FROM spam_quarantine").all()) {
        if (!/^qz-[1-9][0-9]*$/.test(row.id) || !spamQuarantineStatuses.includes(row.status)
          || !Number.isInteger(row.score) || row.score < 0 || row.score > 100
          || row.quarantined_at <= 0 || row.updated_at < row.quarantined_at) throw new Error("Spam quarantine journal requires operator reconciliation");
        let reason; try { reason = JSON.parse(row.reason); } catch { throw new Error("Spam quarantine journal requires operator reconciliation"); }
        if (!Array.isArray(reason) || !reason.every(s => s && typeof s === "object" && typeof s.key === "string" && typeof s.weight === "number" && typeof s.detail === "string"))
          throw new Error("Spam quarantine journal requires operator reconciliation");
        const reviewed = row.status !== "held";
        if ((reviewed ? typeof row.reviewed_by !== "string" || !row.reviewed_by.length || !Number.isInteger(row.reviewed_at) || row.reviewed_at < row.quarantined_at
            : row.reviewed_by !== null || row.reviewed_at !== null || row.note !== null))
          throw new Error("Spam quarantine journal requires operator reconciliation");
        if (row.note !== null && (typeof row.note !== "string" || row.note.length > spamQuarantineLimits.noteChars))
          throw new Error("Spam quarantine journal requires operator reconciliation");
        counts[row.status]++;
      }
      return counts;
    });
  }
  // File one quarantined message as held. flag is a flagMessage() result with
  // quarantine true; its signal list is the durable reason. Ids are qz-<n>
  // with the counter derived from existing rows, so they stay stable and
  // unique across restarts.
  quarantine({ messageId, channel, connectionId = null, flag, at = null }) {
    textOf(messageId, spamQuarantineLimits.messageIdChars, "messageId");
    textOf(channel, spamQuarantineLimits.channelChars, "channel");
    if (connectionId !== null && connectionId !== undefined) textOf(connectionId, spamQuarantineLimits.connectionIdChars, "connectionId");
    const { reason, score } = flagOf(flag);
    if (at !== null && (!Number.isFinite(at) || at < 0)) fail(422, "invalid_quarantine", "at must be a finite ms-epoch time");
    return this.store.transaction(() => {
      const now = at ?? this.store.now();
      const next = this.db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id,4) AS INTEGER)),0) next FROM spam_quarantine").get().next + 1;
      const id = `qz-${next}`;
      this.db.prepare("INSERT INTO spam_quarantine (id,message_id,channel,connection_id,reason,score,quarantined_at,status,reviewed_by,reviewed_at,note,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, messageId, channel, connectionId ?? null, JSON.stringify(reason), score, now, "held", null, null, null, now);
      return view(this.db.prepare("SELECT * FROM spam_quarantine WHERE id=?").get(id));
    });
  }
  get(id) {
    if (typeof id !== "string") fail(422, "invalid_quarantine", "id must be a string");
    return this.store.readTransaction(() => {
      const row = this.db.prepare("SELECT * FROM spam_quarantine WHERE id=?").get(id);
      return row ? view(row) : null;
    });
  }
  held({ limit = null } = {}) {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) fail(422, "invalid_quarantine", "Supply a positive page size.");
    return this.store.readTransaction(() => this.db.prepare("SELECT * FROM spam_quarantine WHERE status='held' ORDER BY quarantined_at LIMIT ?")
      .all(limit ?? -1).map(view));
  }
  counts() {
    return this.store.readTransaction(() => {
      const counts = { held: 0, released: 0, dismissed: 0 };
      for (const row of this.db.prepare("SELECT status,count(*) n FROM spam_quarantine GROUP BY status").all()) counts[row.status] = row.n;
      return counts;
    });
  }
  // Owner review: release it to the inbox, or dismiss it as spam. Reviewed
  // rows are final, like the in-memory queue: a second review is a 409.
  release(id, { reviewer, note = null } = {}) { return this.#transition(id, "released", reviewer, note); }
  dismiss(id, { reviewer, note = null } = {}) { return this.#transition(id, "dismissed", reviewer, note); }
  // Bridge for the spam-guard quarantine path: the same decision vocabulary
  // as createQuarantineQueue's review (release | confirm_spam). confirm_spam
  // dismisses the message as spam; it is not a release.
  review(id, { decision, reviewer, note = null } = {}) {
    if (!spamQuarantineDecisions.includes(decision)) fail(422, "invalid_quarantine", "decision must be release or confirm_spam");
    return decision === "release" ? this.release(id, { reviewer, note }) : this.dismiss(id, { reviewer, note });
  }
  #transition(id, status, reviewer, note) {
    if (typeof id !== "string") fail(422, "invalid_quarantine", "id must be a string");
    textOf(reviewer, spamQuarantineLimits.reviewerChars, "reviewer");
    if (note !== null && (typeof note !== "string" || note.length > spamQuarantineLimits.noteChars))
      fail(422, "invalid_quarantine", `note must be text up to ${spamQuarantineLimits.noteChars} chars`);
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM spam_quarantine WHERE id=?").get(id);
      if (!row) fail(404, "unknown_quarantine", `unknown quarantine id "${id}"`);
      if (row.status !== "held") fail(409, "quarantine_already_reviewed", `quarantine "${id}" is already ${row.status}; reviews are final`);
      const now = this.store.now();
      this.db.prepare("UPDATE spam_quarantine SET status=?,reviewed_by=?,reviewed_at=?,note=?,updated_at=? WHERE id=?")
        .run(status, reviewer, now, note, now, id);
      return view(this.db.prepare("SELECT * FROM spam_quarantine WHERE id=?").get(id));
    });
  }
}
