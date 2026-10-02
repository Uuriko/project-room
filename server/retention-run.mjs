// Production caller for the analytics and audit retention planners.
// Default invocation records a plan and deletes nothing. Deletion runs only
// when allowDeletion is exactly true and the caller supplies deleteRecord.
// The scheduled tick never passes a deleter and never scans the live store.
import { createRetention } from "./retention.mjs";
import { retentionDecisions } from "./audit-retention.mjs";

export const RETENTION_DELETION_ENV = "ROOM_RETENTION_ALLOW_DELETION";
const DEFAULT_POLICIES = Object.freeze({ events: 30, aggregates: 365 });
// One table per cron tick, in this order. These logs are telemetry.
// Room events, unread activity, pending webhook deliveries, and invitation
// journals are not in this list and are never deleted here.
export const RETENTION_TABLES = Object.freeze([
  Object.freeze({ table: "web_fetch_log", days: 30, idColumn: "request_id" }),
  Object.freeze({ table: "web_research_log", days: 30, idColumn: "request_id" })
]);
export const DISPOSABLE_LOG_DAYS = Object.freeze(Object.fromEntries(RETENTION_TABLES.map(spec => [spec.table, spec.days])));
export const RETENTION_BATCH_LIMIT = 100;

class RetentionRunError extends Error {
  constructor(message) { super(message); this.name = "RetentionRunError"; this.code = "invalid_retention_run"; }
}
const fail = message => { throw new RetentionRunError(message); };

export function retentionDeletionAllowed(env) {
  return !!env && env[RETENTION_DELETION_ENV] === "1";
}

// Live retention applies unless an operator sets the flag to exactly "0".
export function liveRetentionApplies(env) {
  return !env || env[RETENTION_DELETION_ENV] !== "0";
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

// Store-backed retention applies one disposable log per call. Room events,
// commands, account_access_events, invitations, unread activity, and pending
// or failed webhook deliveries are excluded. The batch stops at `limit` rows
// or when `deadline` passes. A row is deleted only when its integer timestamp
// is older than that table's policy. Set ROOM_RETENTION_ALLOW_DELETION=0 to
// plan without deleting.
export function runLiveStoreRetention({ store, env, now, limit = RETENTION_BATCH_LIMIT, tableIndex = 0, deadline = Infinity, record } = {}) {
  const db = store?.db;
  if (!db || typeof db.prepare !== "function" || typeof store.transaction !== "function") fail("A live store with a transaction adapter is required");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RETENTION_BATCH_LIMIT) fail("Invalid retention batch limit");
  if (!Number.isSafeInteger(tableIndex)) fail("Invalid retention table");
  if (!(deadline === Infinity || Number.isFinite(deadline))) fail("Invalid retention deadline");
  const clock = now === undefined ? Date.now() : Date.parse(now);
  if (!Number.isSafeInteger(clock) || clock < 0) fail("Invalid retention clock");
  const spec = RETENTION_TABLES[(tableIndex % RETENTION_TABLES.length + RETENTION_TABLES.length) % RETENTION_TABLES.length];
  const apply = liveRetentionApplies(env);
  // One table, one transaction. A failure rolls this table's batch back.
  return store.transaction(() => {
    const cutoff = clock - spec.days * 86400000;
    const rows = db.prepare(`SELECT ${spec.idColumn} AS id FROM ${spec.table} WHERE created_at<? ORDER BY created_at,${spec.idColumn} LIMIT ?`).all(cutoff, limit);
    let deleted = 0;
    let budgetExceeded = false;
    if (apply) {
      const erase = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.idColumn}=? AND created_at<?`);
      for (const row of rows) {
        if (Date.now() > deadline) { budgetExceeded = true; break; }
        deleted += erase.run(row.id, cutoff).changes;
      }
    }
    const receipt = Object.freeze({
      dryRun: !apply, liveStoreScanned: true, deleted, table: spec.table,
      deletionRequested: true, deletionApplied: apply, budgetExceeded,
      batchLimit: limit, recordedAt: new Date(clock).toISOString(),
      excluded: Object.freeze(["events", "commands", "account_access_events", "membership_invitation_events", "activity_events", "agent_webhook_deliveries"]),
      categories: Object.freeze({
        [spec.table]: Object.freeze({
          cutoff: new Date(cutoff).toISOString(), eligible: rows.length, deleted,
          moreMayRemain: budgetExceeded || rows.length === limit
        })
      })
    });
    if (typeof record === "function") record(receipt);
    return receipt;
  });
}
