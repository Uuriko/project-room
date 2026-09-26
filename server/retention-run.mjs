// Production caller for the analytics and audit retention planners.
// Default invocation records a plan and deletes nothing. Deletion runs only
// when allowDeletion is exactly true and the caller supplies deleteRecord.
// The scheduled tick never passes a deleter and never scans the live store.
import { createRetention } from "./retention.mjs";
import { retentionDecisions } from "./audit-retention.mjs";

export const RETENTION_DELETION_ENV = "ROOM_RETENTION_ALLOW_DELETION";
const DEFAULT_POLICIES = Object.freeze({ events: 30, aggregates: 365 });
export const DISPOSABLE_LOG_DAYS = Object.freeze({ web_fetch_log: 30, web_research_log: 30 });
export const RETENTION_BATCH_LIMIT = 100;

class RetentionRunError extends Error {
  constructor(message) { super(message); this.name = "RetentionRunError"; this.code = "invalid_retention_run"; }
}
const fail = message => { throw new RetentionRunError(message); };

export function retentionDeletionAllowed(env) {
  return !!env && env[RETENTION_DELETION_ENV] === "1";
}

const freezePlan = plan => Object.freeze({
  ...plan,
  analytics: Object.freeze({ ...plan.analytics }),
  audit: Object.freeze({ ...plan.audit })
});

// Build both plans, record that plan, then delete only if the flag and a
// deleter are both present. record runs before any deleteRecord call.
export function runRetention({ records = [], events = [], now, policies = DEFAULT_POLICIES, allowDeletion = false, record, deleteRecord } = {}) {
  if (allowDeletion !== true && allowDeletion !== false) fail("allowDeletion must be true or false");
  if (!Array.isArray(records) || !Array.isArray(events)) fail("records and events must be arrays");
  const at = typeof now === "string" ? now : new Date().toISOString();
  const analytics = createRetention({ policies }).purgePlan({ records, now: at });
  const audit = retentionDecisions(events, { now: at, dryRun: allowDeletion !== true });
  const willDelete = allowDeletion === true && typeof deleteRecord === "function";
  const plan = freezePlan({
    dryRun: !willDelete,
    allowDeletion: allowDeletion === true,
    liveStoreScanned: false,
    deletionBlocked: allowDeletion === true && !willDelete ? "no deleter" : null,
    deleted: 0,
    analytics: { keepCount: analytics.keepCount, purgeCount: analytics.purgeCount },
    audit: { keep: audit.totals.keep, archive: audit.totals.archive, purge: audit.totals.purge },
    recordedAt: at
  });
  if (typeof record === "function") record(plan);
  if (!willDelete) return plan;
  let deleted = 0;
  for (const item of analytics.purge) {
    deleteRecord({ kind: "analytics", id: item.id });
    deleted += 1;
  }
  for (const decision of audit.decisions) {
    if (decision.action !== "purge") continue;
    deleteRecord({ kind: "audit", id: decision.id });
    deleted += 1;
  }
  return freezePlan({ ...plan, dryRun: false, deleted });
}

// Cron entry. Reads the deletion flag so the receipt can say it was requested,
// then still plans in dry-run. A passed deleter is ignored.
export function scheduledRetentionTick({ env, now, record, deleteRecord } = {}) {
  const receipt = runRetention({ records: [], events: [], now, allowDeletion: false, record });
  return Object.freeze({
    ...receipt,
    deletionRequested: retentionDeletionAllowed(env),
    deletionApplied: false,
    ignoredDeleter: typeof deleteRecord === "function"
  });
}

export { RetentionRunError };

// Store-backed retention is intentionally narrower than the generic planner:
// these two logs are non-authoritative telemetry. Room events, commands,
// account_access_events, invitations and legal-hold audit rows are excluded.
// Every cycle is bounded. Rerunning it advances past the last batch, without
// deleting any row whose age cannot be proven from its integer timestamp.
export function runLiveStoreRetention({ store, env, now, limit = RETENTION_BATCH_LIMIT, record } = {}) {
  const db = store?.db;
  if (!db || typeof db.prepare !== "function") fail("A live store with a SQLite handle is required");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RETENTION_BATCH_LIMIT) fail("Invalid retention batch limit");
  const clock = now === undefined ? Date.now() : Date.parse(now);
  if (!Number.isSafeInteger(clock) || clock < 0) fail("Invalid retention clock");
  const allowDeletion = retentionDeletionAllowed(env);
  const details = {};
  let deleted = 0;
  // Serialize the scan and writes. A failed category rolls back the whole
  // batch rather than leaving an unreported partial purge.
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, days] of Object.entries(DISPOSABLE_LOG_DAYS)) {
      const cutoff = clock - days * 86400000;
      // Identifiers come only from this closed, hardcoded table list.
      const rows = db.prepare(`SELECT request_id FROM ${table} WHERE created_at<? ORDER BY created_at,request_id LIMIT ?`).all(cutoff, limit);
      if (allowDeletion) {
        const erase = db.prepare(`DELETE FROM ${table} WHERE request_id=? AND created_at<?`);
        for (const row of rows) deleted += erase.run(row.request_id, cutoff).changes;
      }
      details[table] = { cutoff: new Date(cutoff).toISOString(), eligible: rows.length,
        moreMayRemain: rows.length === limit };
    }
    const receipt = Object.freeze({ dryRun: !allowDeletion, liveStoreScanned: true, deleted,
      deletionRequested: allowDeletion, deletionApplied: allowDeletion,
      batchLimitPerCategory: limit, recordedAt: new Date(clock).toISOString(),
      excluded: Object.freeze(["events", "commands", "account_access_events", "membership_invitation_events"]),
      categories: Object.freeze(details) });
    if (typeof record === "function") record(receipt);
    db.exec("COMMIT");
    return receipt;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
