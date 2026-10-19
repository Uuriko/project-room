// Production caller for the analytics and audit retention planners.
// Default invocation records a plan and deletes nothing. Deletion runs only
// when allowDeletion is exactly true and the caller supplies deleteRecord.
// The scheduled tick never passes a deleter and never scans the live store.
import { createRetention } from "./retention.mjs";
import { retentionDecisions } from "./audit-retention.mjs";
import { RETENTION_AGE_DRAIN_TABLES, retentionDispositionFor } from "./retention-registry.mjs";

export const RETENTION_DELETION_ENV = "ROOM_RETENTION_ALLOW_DELETION";
const DEFAULT_POLICIES = Object.freeze({ events: 30, aggregates: 365 });
// The tables the scheduled tick drains itself are the age-ruled rows of
// server/retention-registry.mjs — the registry is the decision record for
// every table, this list is only its drain subset. These logs are
// telemetry. Room events, unread activity, pending webhook deliveries, and
// invitation journals are never deleted here; the receipt names their
// recorded dispositions instead (RECEIPT_EXCLUDED_TABLES below).
export const RETENTION_TABLES = RETENTION_AGE_DRAIN_TABLES;
export const DISPOSABLE_LOG_DAYS = Object.freeze(Object.fromEntries(RETENTION_TABLES.map(spec => [spec.table, spec.days])));
// Rows deleted per batch inside one table's drain. A tick loops batches
// until the table is empty or the tick's deadline passes, so this is a
// transaction-size knob, not a per-tick ceiling (HUNT-SOAK S-4: the old
// shape — one table per tick, 100 rows — capped each log at
// <=1,200 drained rows/day no matter how fast rows arrived).
export const RETENTION_BATCH_LIMIT = 500;
// The tables the pre-registry receipt named as a bare "excluded" list.
// They stay named in the receipt, now carrying the disposition the
// retention registry records for each of them.
const RECEIPT_EXCLUDED_TABLES = Object.freeze([
  "events", "commands", "account_access_events",
  "membership_invitation_events", "activity_events", "agent_webhook_deliveries"
]);

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

// Store-backed retention drains every age-ruled table in the retention
// registry on every call. Per table it loops batches of `limit` rows until
// no eligible rows remain or `deadline` passes; the deadline is the job's
// budget (server/jobs.mjs JOB_BUDGET_MS via ctx.deadline, the worker's
// cron deadline), so a backlog drains across consecutive ticks instead of
// being capped per tick (HUNT-SOAK S-4). A row is deleted only when its
// integer timestamp is older than that table's policy. Room events,
// commands, account_access_events, invitations, unread activity, and
// pending or failed webhook deliveries are never deleted here — the
// receipt records their registry dispositions. Each table drains in its
// own transaction: a failure rolls that table's drain back, never a table
// that already finished. Set ROOM_RETENTION_ALLOW_DELETION=0 to plan
// without deleting.
export function runLiveStoreRetention({ store, env, now, limit = RETENTION_BATCH_LIMIT, deadline = Infinity, record } = {}) {
  const db = store?.db;
  if (!db || typeof db.prepare !== "function" || typeof store.transaction !== "function") fail("A live store with a transaction adapter is required");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RETENTION_BATCH_LIMIT) fail("Invalid retention batch limit");
  if (!(deadline === Infinity || Number.isFinite(deadline))) fail("Invalid retention deadline");
  const clock = now === undefined ? Date.now() : Date.parse(now);
  if (!Number.isSafeInteger(clock) || clock < 0) fail("Invalid retention clock");
  const apply = liveRetentionApplies(env);
  const categories = {};
  let deletedTotal = 0;
  let budgetExceeded = false;
  for (const spec of RETENTION_TABLES) {
    const cutoff = clock - spec.days * 86400000;
    const eligible = db.prepare(`SELECT count(*) AS n FROM ${spec.table} WHERE created_at<?`).get(cutoff).n;
    let deleted = 0;
    let batches = 0;
    let tableBudgetExceeded = false;
    if (apply && eligible > 0) {
      const outcome = store.transaction(() => {
        let gone = 0;
        let runs = 0;
        let exceeded = false;
        const erase = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.idColumn}=? AND created_at<?`);
        while (gone < eligible) {
          const rows = db.prepare(`SELECT ${spec.idColumn} AS id FROM ${spec.table} WHERE created_at<? ORDER BY created_at,${spec.idColumn} LIMIT ?`).all(cutoff, limit);
          if (!rows.length) break;
          runs += 1;
          let batchGone = 0;
          for (const row of rows) {
            if (Date.now() > deadline) { exceeded = true; break; }
            batchGone += erase.run(row.id, cutoff).changes;
          }
          gone += batchGone;
          if (exceeded || batchGone === 0 || rows.length < limit) break;
        }
        return { gone, runs, exceeded };
      });
      deleted = outcome.gone;
      batches = outcome.runs;
      tableBudgetExceeded = outcome.exceeded;
    }
    if (tableBudgetExceeded) budgetExceeded = true;
    deletedTotal += deleted;
    categories[spec.table] = Object.freeze({
      cutoff: new Date(cutoff).toISOString(), eligible, deleted, batches,
      moreMayRemain: eligible - deleted > 0
    });
  }
  const receipt = Object.freeze({
    dryRun: !apply, liveStoreScanned: true, deleted: deletedTotal,
    tables: Object.freeze(RETENTION_TABLES.map(spec => spec.table)),
    deletionRequested: true, deletionApplied: apply, budgetExceeded,
    batchLimit: limit, recordedAt: new Date(clock).toISOString(),
    excluded: Object.freeze(RECEIPT_EXCLUDED_TABLES.map(table => {
      const row = retentionDispositionFor(table);
      return Object.freeze({
        table, disposition: row.disposition,
        reason: row.reason ?? row.rule.detail
      });
    })),
    categories: Object.freeze(categories)
  });
  if (typeof record === "function") record(receipt);
  return receipt;
}
