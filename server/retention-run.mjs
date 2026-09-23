// Production caller for the analytics and audit retention planners.
// Default invocation records a plan and deletes nothing. Deletion runs only
// when allowDeletion is exactly true and the caller supplies deleteRecord.
// The scheduled tick never passes a deleter and never scans the live store.
import { createRetention } from "./retention.mjs";
import { retentionDecisions } from "./audit-retention.mjs";

export const RETENTION_DELETION_ENV = "ROOM_RETENTION_ALLOW_DELETION";
const DEFAULT_POLICIES = Object.freeze({ events: 30, aggregates: 365 });

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
