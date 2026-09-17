// F022: log retention policy + enforcement (pairs with the F004 audit log UI
// and the F020 audit receipts chain).
//
// This module answers "how long do we keep log entries, and who enforces
// that". It defines retention policies (per-log-type windows plus a
// catch-all), evaluates which entries are due for disposal, and enforces the
// decision against an injectable store. Main-chat quill's H-lane
// server/audit-retention.mjs is the server-side audit store policy; this
// module is the F-lane evaluation/enforcement engine for the audit-log chain
// and deliberately lives in its own two files with no store of its own.
//
// API:
//   DEFAULT_POLICY                  — the stock policy: audit logs archive
//                                     after 7 years, security events archive
//                                     after 1 year, operational logs purge
//                                     after 90 days; unknown log types fall
//                                     back to the 90-day purge default.
//   createPolicy(overrides)         — merge overrides over DEFAULT_POLICY and
//                                     validate; throws TypeError on invalid
//                                     windows (missing days/action, negative
//                                     or non-integer days, unknown action).
//   evaluateRetention(entries, policy, now)
//                                   — pure: classifies every entry as due
//                                     (with the action to take), held (legal
//                                     hold — never disposed), or retained
//                                     (within its window or undateable).
//                                     `now` is injectable (Date | ms | ISO
//                                     string); defaults to Date.now().
//   enforceRetention(store, policy, { now, dryRun, onAction })
//                                   — runs evaluateRetention over
//                                     store.list(), applies archive/purge
//                                     calls, and returns a report. dryRun
//                                     plans the actions without writing.
//                                     A store write failure is recorded in
//                                     the report and never aborts the batch.
//
// Entry shape: { sequence, event, logType?, legalHold? } where event is the
// F004 audit event { id, type, roomId, actorId, at, data }. logType may also
// live on event.logType; legalHold may be set on the entry, the event, or
// event.data — any one of them protects the entry. Bare events (no
// { sequence, event } wrapper) are tolerated. Entries whose timestamp cannot
// be parsed are always retained: this module never disposes of an entry it
// cannot prove is expired.
//
// Store shape: { list() -> entries[], archive(entry), purge(entry) }. In
// dryRun mode archive/purge are never called and may be omitted entirely,
// so a read-only store is enough to plan a run.
//
// Actions: "archive" (move the entry to cold storage — the archive itself is
// the caller's business; this module only routes the entry) and "purge"
// (drop the entry for good).

export const ACTION_ARCHIVE = "archive";
export const ACTION_PURGE = "purge";

export const DEFAULT_POLICY = {
  name: "default-retention",
  version: 1,
  windows: {
    audit: { days: 2555, action: ACTION_ARCHIVE, label: "Audit trail entries" },
    security: { days: 365, action: ACTION_ARCHIVE, label: "Security event entries" },
    operational: { days: 90, action: ACTION_PURGE, label: "Operational log entries" }
  },
  default: { days: 90, action: ACTION_PURGE, label: "Unclassified log entries" }
};

const ACTIONS = new Set([ACTION_ARCHIVE, ACTION_PURGE]);

function validateWindow(type, window) {
  if (window === null || typeof window !== "object" || Array.isArray(window)) {
    throw new TypeError(`createPolicy: window for "${type}" must be an object`);
  }
  if (!Number.isInteger(window.days) || window.days < 0) {
    throw new TypeError(`createPolicy: window for "${type}" needs days as a non-negative integer`);
  }
  if (!ACTIONS.has(window.action)) {
    throw new TypeError(`createPolicy: window for "${type}" needs action "archive" or "purge"`);
  }
  return {
    days: window.days,
    action: window.action,
    label: typeof window.label === "string" && window.label.length > 0 ? window.label : `${type} log entries`
  };
}

// Build a policy from overrides merged over DEFAULT_POLICY. Overrides may
// replace whole windows or supply a new default / name / version; partial
// windows replace rather than merge so a policy file stays auditable.
export function createPolicy(overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("createPolicy: overrides must be an object");
  }
  const windows = {};
  const source = overrides.windows ?? DEFAULT_POLICY.windows;
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("createPolicy: windows must be an object keyed by log type");
  }
  for (const [type, window] of Object.entries(source)) {
    windows[type] = validateWindow(type, window);
  }
  const def = overrides.default ?? DEFAULT_POLICY.default;
  const policy = {
    name: typeof overrides.name === "string" && overrides.name.length > 0 ? overrides.name : DEFAULT_POLICY.name,
    version: overrides.version ?? DEFAULT_POLICY.version,
    windows,
    default: validateWindow("default", def)
  };
  if (!Number.isInteger(policy.version) || policy.version < 0) {
    throw new TypeError("createPolicy: version must be a non-negative integer");
  }
  return policy;
}

// Normalize an injectable clock: Date, epoch ms, or ISO string. Throws on
// unparseable input so a bad clock can never silently shift every cutoff.
function toMs(now) {
  if (now === undefined || now === null) return Date.now();
  if (now instanceof Date) {
    const ms = now.getTime();
    if (Number.isNaN(ms)) throw new TypeError("retention: now must be a valid time");
    return ms;
  }
  if (typeof now === "number") {
    if (!Number.isFinite(now)) throw new TypeError("retention: now must be a valid time");
    return now;
  }
  if (typeof now === "string") {
    const ms = Date.parse(now);
    if (Number.isNaN(ms)) throw new TypeError("retention: now must be a valid time");
    return ms;
  }
  throw new TypeError("retention: now must be a Date, epoch ms, or ISO string");
}

// Normalize an entry: tolerate the bare-event shorthand the same way
// src/audit-log-ui.mjs does, and read logType / legalHold wherever the
// caller put them.
function normalizeEntry(row) {
  const entry = row && typeof row === "object" && "event" in row ? row : { event: row };
  const event = entry.event && typeof entry.event === "object" ? entry.event : {};
  const logType = entry.logType ?? event.logType;
  const legalHold = entry.legalHold === true
    || event.legalHold === true
    || (event.data && typeof event.data === "object" && event.data.legalHold === true);
  const at = event.at;
  const atMs = typeof at === "number" && Number.isFinite(at)
    ? at
    : typeof at === "string" ? Date.parse(at) : NaN;
  return {
    row: entry,
    sequence: entry.sequence,
    eventId: event.id ?? null,
    logType: typeof logType === "string" && logType.length > 0 ? logType : null,
    legalHold,
    atMs: Number.isNaN(atMs) ? null : atMs
  };
}

function windowFor(policy, logType) {
  if (logType !== null && Object.hasOwn(policy.windows, logType)) return policy.windows[logType];
  return policy.default;
}

// Pure classification. Returns { due, held, retained }:
//   due:      [{ entry, sequence, eventId, logType, action, ageDays, cutoffAt }]
//   held:     [{ entry, sequence, eventId, reason: "legal-hold" }]
//   retained: [{ entry, sequence, eventId, reason: "within-window" | "unparseable-timestamp" }]
// An entry is due when its age in whole days is at or past the window.
// Throws TypeError on a null/invalid policy; null entries are skipped.
export function evaluateRetention(entries, policy, now) {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("evaluateRetention: policy must be a policy object");
  }
  if (policy.windows === null || typeof policy.windows !== "object") {
    throw new TypeError("evaluateRetention: policy.windows must be an object");
  }
  validateWindow("default", policy.default);
  const list = Array.isArray(entries) ? entries : [];
  const nowMs = toMs(now);
  const due = [];
  const held = [];
  const retained = [];
  for (const row of list) {
    if (row === null || typeof row !== "object") continue;
    const n = normalizeEntry(row);
    if (n.legalHold) {
      held.push({ entry: n.row, sequence: n.sequence, eventId: n.eventId, reason: "legal-hold" });
      continue;
    }
    if (n.atMs === null) {
      // Never dispose of an entry whose age cannot be proven.
      retained.push({ entry: n.row, sequence: n.sequence, eventId: n.eventId, reason: "unparseable-timestamp" });
      continue;
    }
    const window = windowFor(policy, n.logType);
    const ageDays = Math.floor((nowMs - n.atMs) / 86_400_000);
    if (ageDays >= window.days) {
      due.push({
        entry: n.row,
        sequence: n.sequence,
        eventId: n.eventId,
        logType: n.logType ?? "default",
        action: window.action,
        ageDays,
        cutoffAt: new Date(n.atMs + window.days * 86_400_000).toISOString()
      });
    } else {
      retained.push({ entry: n.row, sequence: n.sequence, eventId: n.eventId, reason: "within-window" });
    }
  }
  return { due, held, retained };
}

function checkStore(store, dryRun) {
  if (store === null || typeof store !== "object") {
    throw new TypeError("enforceRetention: store must be an object with a list() method");
  }
  if (typeof store.list !== "function") {
    throw new TypeError("enforceRetention: store must provide list()");
  }
  if (!dryRun) {
    if (typeof store.archive !== "function") throw new TypeError("enforceRetention: store must provide archive() (or use dryRun)");
    if (typeof store.purge !== "function") throw new TypeError("enforceRetention: store must provide purge() (or use dryRun)");
  }
}

// Apply a policy against an injectable store. Options:
//   now     — injectable clock, same shapes as evaluateRetention.
//   dryRun  — true plans the actions and reports them without calling
//             store.archive/store.purge at all.
//   onAction — optional callback receiving each action record as it is
//             planned or executed (useful for progress or logging).
// Returns a report:
//   { runAt, dryRun, policyName, policyVersion, scanned,
//     archived, purged, held, retained, failed, actions }
// actions[] entries are { sequence, eventId, logType, action, ageDays,
// status, error? } where status is "planned" (dry run), "done", or "failed".
// A store write that throws is recorded as failed and the batch continues.
export function enforceRetention(store, policy, { now, dryRun = false, onAction } = {}) {
  checkStore(store, dryRun);
  const nowMs = toMs(now);
  const entries = store.list();
  const plan = evaluateRetention(entries, policy, nowMs);
  const actions = [];
  let archived = 0;
  let purged = 0;
  let failed = 0;
  for (const item of plan.due) {
    const record = {
      sequence: item.sequence,
      eventId: item.eventId,
      logType: item.logType,
      action: item.action,
      ageDays: item.ageDays,
      status: dryRun ? "planned" : "done"
    };
    if (dryRun) {
      actions.push(record);
      if (typeof onAction === "function") onAction(record);
      continue;
    }
    try {
      if (item.action === ACTION_ARCHIVE) store.archive(item.entry);
      else store.purge(item.entry);
      if (item.action === ACTION_ARCHIVE) archived += 1;
      else purged += 1;
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      failed += 1;
    }
    actions.push(record);
    if (typeof onAction === "function") onAction(record);
  }
  return {
    runAt: new Date(nowMs).toISOString(),
    dryRun: Boolean(dryRun),
    policyName: policy?.name ?? null,
    policyVersion: policy?.version ?? null,
    scanned: plan.due.length + plan.held.length + plan.retained.length,
    archived,
    purged,
    held: plan.held.length,
    retained: plan.retained.length,
    failed,
    actions
  };
}
