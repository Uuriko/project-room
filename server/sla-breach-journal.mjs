// Durable SLA-breach alert journal (task 26): the in-app sink for the
// SlaSweeper's deliver hook (see server/sla-sweep-hooks.mjs). Breach alerts
// the urgent path decides to deliver land here as immutable receipts — the
// same journaled-notification pattern the import path uses for its notify
// decisions (decision + prefs snapshot recorded so the journal replay can
// recompute the decision deterministically).
//
// In-app first: format, delivery channel and push are John's call (task 22),
// so the journal is the delivery — the owner reads it in the inbox surface
// and the end-of-day "nothing closes unowned" review reads it alongside the
// producer's activeAlerts(). No external sends, no push, no wake.
//
// Filing is idempotent per produced record (account_id, thread_id,
// produced_at): the producer's ledger dedupes in-process, and the unique key
// keeps a restarted sweeper from double-journaling the same alert. A later
// re-breach produces a new produced_at and files a new receipt.
//
// Purely additive, like spam_quarantine and pending_channel_updates: no
// schema version bump, no writer-fence impact, because a pre-journal writer
// has no code path to this table and the recovery audit's exact table list
// is the integrity gate. All writes go through the store transaction.
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
// snapshotBytes caps the journaled prefs snapshot (a prefs snapshot is a
// handful of quiet-hours/connection rows; the cap guards against pathological
// growth, mirroring the quarantine journal's reason cap).
export const slaBreachAlertLimits = Object.freeze({ idChars: 64, accountIdChars: 512, threadIdChars: 1024,
  channelChars: 128, kindChars: 32, summaryChars: 4096, decisionChars: 32, reasonChars: 1024,
  snapshotBytes: 16384, batch: 500 });
export const slaBreachAlertSchema = `
  CREATE TABLE IF NOT EXISTS sla_breach_alerts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    kind TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
    target_ms INTEGER NOT NULL CHECK(target_ms > 0),
    awaiting_since TEXT NOT NULL,
    deadline_at TEXT,
    produced_at TEXT NOT NULL,
    summary TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    prefs_snapshot TEXT NOT NULL CHECK(json_valid(prefs_snapshot)),
    notified_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(account_id, thread_id, produced_at)
  );
  CREATE INDEX IF NOT EXISTS sla_breach_alerts_account ON sla_breach_alerts(account_id, notified_at);
`;
const view = row => Object.freeze({ id: row.id, accountId: row.account_id, threadId: row.thread_id,
  channel: row.channel, kind: row.kind, elapsedMs: row.elapsed_ms, targetMs: row.target_ms,
  awaitingSince: row.awaiting_since, deadlineAt: row.deadline_at, producedAt: row.produced_at,
  summary: row.summary, decision: row.decision, reason: row.reason,
  prefsSnapshot: JSON.parse(row.prefs_snapshot), notifiedAt: row.notified_at, createdAt: row.created_at });
const textOf = (value, limit, field) => {
  if (typeof value !== "string" || value.length === 0 || value.length > limit)
    fail(422, "invalid_sla_alert", `${field} must be a 1..${limit} character string`);
  return value;
};
const recordOf = record => {
  if (!record || typeof record !== "object" || Array.isArray(record))
    fail(422, "invalid_sla_alert", "record must be a breach record object");
  textOf(record.threadId, slaBreachAlertLimits.threadIdChars, "record.threadId");
  textOf(record.channel, slaBreachAlertLimits.channelChars, "record.channel");
  textOf(record.kind, slaBreachAlertLimits.kindChars, "record.kind");
  textOf(record.summary, slaBreachAlertLimits.summaryChars, "record.summary");
  if (typeof record.elapsedMs !== "number" || !Number.isFinite(record.elapsedMs) || record.elapsedMs < 0)
    fail(422, "invalid_sla_alert", "record.elapsedMs must be a non-negative number");
  if (typeof record.targetMs !== "number" || !Number.isFinite(record.targetMs) || record.targetMs <= 0)
    fail(422, "invalid_sla_alert", "record.targetMs must be a positive number");
  for (const [field, value] of [["record.awaitingSince", record.awaitingSince], ["record.producedAt", record.producedAt]]) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
      fail(422, "invalid_sla_alert", `${field} must be a parseable timestamp`);
  }
  if (record.deadlineAt !== undefined && record.deadlineAt !== null
    && (typeof record.deadlineAt !== "string" || !Number.isFinite(Date.parse(record.deadlineAt))))
    fail(422, "invalid_sla_alert", "record.deadlineAt must be a parseable timestamp when present");
  return record;
};
const decisionOf = decision => {
  if (!decision || typeof decision !== "object" || Array.isArray(decision))
    fail(422, "invalid_sla_alert", "decision must be a notify decision object");
  textOf(decision.decision, slaBreachAlertLimits.decisionChars, "decision.decision");
  if (typeof decision.reason !== "string" || decision.reason.length > slaBreachAlertLimits.reasonChars)
    fail(422, "invalid_sla_alert", "decision.reason must be a string");
  return decision;
};
const snapshotOf = snapshot => {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    fail(422, "invalid_sla_alert", "prefsSnapshot must be an object");
  let json;
  try { json = JSON.stringify(snapshot); } catch { fail(422, "invalid_sla_alert", "prefsSnapshot must be JSON-safe"); }
  if (json === undefined || Buffer.byteLength(json) > slaBreachAlertLimits.snapshotBytes)
    fail(422, "invalid_sla_alert", "prefsSnapshot is too large to journal");
  return json;
};

export class SlaBreachAlertJournal {
  constructor(store) { this.store = store; this.db = store.db; }
  // File one delivered breach alert as an immutable receipt. Idempotent per
  // (accountId, threadId, producedAt): re-filing the same produced record
  // returns the existing receipt instead of double-journaling.
  notify({ accountId, record, decision, prefsSnapshot, at = null }) {
    textOf(accountId, slaBreachAlertLimits.accountIdChars, "accountId");
    const cleanRecord = recordOf(record), cleanDecision = decisionOf(decision);
    const snapshotJson = snapshotOf(prefsSnapshot);
    if (at !== null && (!Number.isFinite(at) || at < 0)) fail(422, "invalid_sla_alert", "at must be a finite ms-epoch time");
    return this.store.transaction(() => {
      const now = at ?? this.store.now();
      const next = this.db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id,5) AS INTEGER)),0) next FROM sla_breach_alerts").get().next + 1;
      const id = `sba-${next}`;
      this.db.prepare(`INSERT INTO sla_breach_alerts
        (id,account_id,thread_id,channel,kind,elapsed_ms,target_ms,awaiting_since,deadline_at,produced_at,
         summary,decision,reason,prefs_snapshot,notified_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,thread_id,produced_at) DO NOTHING`)
        .run(id, accountId, cleanRecord.threadId, cleanRecord.channel, cleanRecord.kind,
          Math.round(cleanRecord.elapsedMs), Math.round(cleanRecord.targetMs), cleanRecord.awaitingSince,
          cleanRecord.deadlineAt ?? null, cleanRecord.producedAt, cleanRecord.summary,
          cleanDecision.decision, cleanDecision.reason, snapshotJson, now, now);
      const row = this.db.prepare("SELECT * FROM sla_breach_alerts WHERE account_id=? AND thread_id=? AND produced_at=?")
        .get(accountId, cleanRecord.threadId, cleanRecord.producedAt);
      return view(row);
    });
  }
  get(id) {
    if (typeof id !== "string") fail(422, "invalid_sla_alert", "id must be a string");
    return this.store.readTransaction(() => {
      const row = this.db.prepare("SELECT * FROM sla_breach_alerts WHERE id=?").get(id);
      return row ? view(row) : null;
    });
  }
  // Newest first; the in-app read path for the end-of-day review.
  list(accountId, { limit = slaBreachAlertLimits.batch } = {}) {
    textOf(accountId, slaBreachAlertLimits.accountIdChars, "accountId");
    if (!Number.isInteger(limit) || limit < 1 || limit > slaBreachAlertLimits.batch)
      fail(422, "invalid_sla_alert", `limit must be an integer 1..${slaBreachAlertLimits.batch}`);
    return this.store.readTransaction(() => Object.freeze(
      this.db.prepare("SELECT * FROM sla_breach_alerts WHERE account_id=? ORDER BY notified_at DESC,id DESC LIMIT ?")
        .all(accountId, limit).map(view)));
  }
}
