// TD-0: per-tool MCP call telemetry (TOOL-DIET prerequisite).
//
// Every MCP tools/call and tools/list on the hosted and stdio surfaces
// lands here as ONE daily-rollup row: (day, surface, kind, tool, profile,
// focus, caller class, outcome) -> call count + first/last seen. There are
// no argument payloads, no result bodies, no identity ids and no credential
// material in this store — counts and metadata only (data-programme bright
// lines B2/B9). The diet programme (TD-9) consumes mcpToolUsageReport:
// per-name counts by caller class, days-since-last-call per name, the
// listing profile/focus mix, and the non-fleet distinct-legacy-name count
// behind the programme kill criterion.
//
// Caller classes:
//   anonymous         no credential presented
//   api_key           a scoped API key (rak_…) — the key, never its owner
//   fleet_identity    an identity secret whose identity id is configured
//                     in ANALYTICS_LANE_ACTOR_IDS (the same configured lane
//                     set the dashboard honesty split uses; membership is
//                     configured, never guessed — with the set empty every
//                     identity caller reads external_identity)
//   guest             an identity secret whose room seats are all guest
//                     seats (server/membership-resolution.mjs)
//   external_identity any other identity secret
//
// Retention: rows are daily aggregates, kept MCP_TELEMETRY_RETENTION_DAYS
// days (400 — thirteen months of sunset evidence), pruned opportunistically
// on the write path at most once per day per database handle. The table is
// lazy/additive like the wake-metrics tables: created on first record,
// registered in writer-fence lazyAdditiveTables, retained (not room-purged)
// in the purge registry because it carries no room/identity/account key,
// and skipped on backup replay (a restored store restarts its window).
//
// Writes never fail a tool call: recordMcpTelemetry swallows every error
// and returns whether the row landed. One UPSERT per call rides the
// request's existing write patterns (identity resolution already writes
// noteMcpUse on this path); no sampling at current volume — if the write
// path ever proves hot, TD-0's charter answer is 1-in-N sampling with the
// rate recorded here, not silent loss.
import { utcDay, tableExists } from "./schema.mjs";
import { API_KEY_PREFIX } from "../agent-api-keys.mjs";
import { identityRoomSeats } from "../membership-resolution.mjs";

export const MCP_TELEMETRY_TABLE = "mcp_tool_daily";
export const MCP_TELEMETRY_RETENTION_DAYS = 400;
export const MCP_CALLER_CLASSES = Object.freeze([
  "anonymous", "api_key", "fleet_identity", "guest", "external_identity"
]);
export const MCP_TELEMETRY_SURFACES = Object.freeze(["hosted", "stdio"]);
const OUTCOMES = Object.freeze(["success", "error"]);
const PROFILES = Object.freeze(["", "core", "lean", "full", "public", "stdio"]);
const DAY_MS = 86400000;

export const MCP_TELEMETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_tool_daily (
  day TEXT NOT NULL,
  surface TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool_name TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  focus TEXT NOT NULL DEFAULT '',
  caller_class TEXT NOT NULL,
  outcome TEXT NOT NULL,
  calls INT NOT NULL,
  first_at INT NOT NULL,
  last_at INT NOT NULL,
  PRIMARY KEY (day, surface, kind, tool_name, profile, focus, caller_class, outcome)
);
CREATE INDEX IF NOT EXISTS mcp_tool_daily_tool ON mcp_tool_daily(tool_name, day);
`;

const ensured = new WeakSet();
const lastPruneDay = new WeakMap();

export function ensureMcpTelemetrySchema(db) {
  if (!db || ensured.has(db)) return false;
  db.exec(MCP_TELEMETRY_SCHEMA);
  ensured.add(db);
  return true;
}

// Mirrors parseIdList in dashboard-honesty.mjs (kept local so this module
// stays import-light enough for the stdio client bundle).
export function fleetIdentityIdsFromEnv(env = process.env) {
  const value = env?.ANALYTICS_LANE_ACTOR_IDS;
  if (typeof value !== "string") return new Set();
  return new Set(value.split(",").map(part => part.trim()).filter(Boolean));
}

export function classifyMcpCaller({ secret = null, identityId = null, guestOnly = false, env = process.env } = {}) {
  if (typeof secret !== "string" || secret.length === 0) return "anonymous";
  if (secret.startsWith(API_KEY_PREFIX)) return "api_key";
  if (typeof identityId === "string" && fleetIdentityIdsFromEnv(env).has(identityId)) return "fleet_identity";
  if (guestOnly) return "guest";
  return "external_identity";
}

// True when the identity holds at least one room seat and every seat is a
// guest seat. Throws nothing: an unresolvable identity is not a guest.
export function isGuestOnlyIdentity(db, identityId) {
  try {
    const seats = identityRoomSeats(db, identityId);
    return seats.length > 0 && seats.every(seat => seat.seat === "guest");
  } catch {
    return false;
  }
}

// success unless the reply is a JSON-RPC error or a tool-level isError.
export function mcpReplyOutcome(reply) {
  if (!reply || typeof reply !== "object") return "error";
  if (reply.error) return "error";
  return reply.result?.isError ? "error" : "success";
}

const safeName = value => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_.-]*$/.test(value) ? value : "";
const safeFocus = value => typeof value === "string" && value.length <= 32 && /^[a-z_]*$/.test(value) ? value : "";

export function pruneMcpTelemetry(db, { now = Date.now(), retentionDays = MCP_TELEMETRY_RETENTION_DAYS } = {}) {
  if (!db || !tableExists(db, MCP_TELEMETRY_TABLE)) return 0;
  const cutoffDay = utcDay(now - retentionDays * DAY_MS);
  return db.prepare(`DELETE FROM ${MCP_TELEMETRY_TABLE} WHERE day < ?`).run(cutoffDay).changes;
}

// Record one call (or one tools/list request) into the daily rollup.
// Never throws; returns true when the row landed.
export function recordMcpTelemetry(db, {
  surface, kind = "call", tool = "", profile = "", focus = "",
  callerClass, outcome, at = Date.now(), n = 1
} = {}) {
  try {
    if (!db || typeof db.prepare !== "function") return false;
    if (!MCP_TELEMETRY_SURFACES.includes(surface)) return false;
    if (kind !== "call" && kind !== "list") return false;
    if (!MCP_CALLER_CLASSES.includes(callerClass) || !OUTCOMES.includes(outcome)) return false;
    if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(at) || at < 0) return false;
    ensureMcpTelemetrySchema(db);
    const day = utcDay(at);
    if (lastPruneDay.get(db) !== day) {
      lastPruneDay.set(db, day);
      try { pruneMcpTelemetry(db, { now: at }); } catch { /* retention never blocks a call */ }
    }
    db.prepare(`INSERT INTO ${MCP_TELEMETRY_TABLE}
        (day, surface, kind, tool_name, profile, focus, caller_class, outcome, calls, first_at, last_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, surface, kind, tool_name, profile, focus, caller_class, outcome)
      DO UPDATE SET calls = calls + excluded.calls,
        first_at = MIN(first_at, excluded.first_at),
        last_at = MAX(last_at, excluded.last_at)`)
      .run(day, surface, kind, safeName(tool), PROFILES.includes(profile) ? profile : "", safeFocus(focus),
        callerClass, outcome, n, at, at);
    return true;
  } catch {
    return false;
  }
}

// The read side the diet programme consumes. Window counts cover the last
// `days` UTC days including today; lastSeen spans the whole retention
// window so a name with zero calls in 30 consecutive days is provable, and
// legacyNames (the TD-1 registry's legacy set, when the caller has it)
// turns the programme kill criterion — non-fleet callers genuinely using
// >= 15 distinct legacy names — into one number.
export function mcpToolUsageReport(db, { days = 7, now = Date.now(), legacyNames = null } = {}) {
  const windowDays = Number.isSafeInteger(days) && days > 0 ? days : 7;
  const sinceDay = utcDay(now - (windowDays - 1) * DAY_MS);
  const empty = Object.freeze({
    generatedAt: now, windowDays, sinceDay,
    calls: Object.freeze([]), lastSeen: Object.freeze([]),
    listRequests: Object.freeze([]), nonFleetLegacy: null
  });
  if (!db || !tableExists(db, MCP_TELEMETRY_TABLE)) return empty;
  const calls = db.prepare(`SELECT tool_name AS tool, surface, caller_class AS callerClass,
      SUM(calls) AS calls,
      SUM(CASE WHEN outcome = 'success' THEN calls ELSE 0 END) AS successes,
      SUM(CASE WHEN outcome = 'error' THEN calls ELSE 0 END) AS errors,
      MAX(last_at) AS lastAt
    FROM ${MCP_TELEMETRY_TABLE}
    WHERE kind = 'call' AND day >= ?
    GROUP BY tool_name, surface, caller_class
    ORDER BY tool_name, surface, caller_class`).all(sinceDay);
  const lastSeen = db.prepare(`SELECT tool_name AS tool, MAX(last_at) AS lastAt
    FROM ${MCP_TELEMETRY_TABLE}
    WHERE kind = 'call'
    GROUP BY tool_name ORDER BY tool_name`).all()
    .map(row => ({ ...row, daysSinceLastCall: Math.max(0, Math.floor((now - row.lastAt) / DAY_MS)) }));
  const listRequests = db.prepare(`SELECT profile, focus, surface, caller_class AS callerClass,
      SUM(calls) AS requests,
      SUM(CASE WHEN outcome = 'error' THEN calls ELSE 0 END) AS errors
    FROM ${MCP_TELEMETRY_TABLE}
    WHERE kind = 'list' AND day >= ?
    GROUP BY profile, focus, surface, caller_class
    ORDER BY profile, focus, surface, caller_class`).all(sinceDay);
  let nonFleetLegacy = null;
  if (Array.isArray(legacyNames)) {
    const legacy = new Set(legacyNames.filter(name => typeof name === "string"));
    const names = [...new Set(calls
      .filter(row => row.callerClass !== "fleet_identity" && legacy.has(row.tool))
      .map(row => row.tool))].sort();
    nonFleetLegacy = Object.freeze({ distinctNames: names.length, names: Object.freeze(names) });
  }
  return Object.freeze({
    generatedAt: now, windowDays, sinceDay,
    calls: Object.freeze(calls.map(row => Object.freeze(row))),
    lastSeen: Object.freeze(lastSeen.map(row => Object.freeze(row))),
    listRequests: Object.freeze(listRequests.map(row => Object.freeze(row))),
    nonFleetLegacy
  });
}
