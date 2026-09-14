// F5: read-only usage summary per room.
//
// One derived read over data every member can already see: the membership
// projection (human seats vs agent principals), the identity links table,
// the work-session events in the period and the bounded pilot caps the
// write paths in store.mjs enforce. Nothing here writes, and the response
// carries counts only - no member details, credentials, hashes or bodies.
//
// Spend is what agents reported on their sessions (spendCents is cumulative
// per attempt). A session that never reported spend is counted as
// unreported and the total stays "unknown" until at least one attempt
// reports - unknown is never rendered as zero.

import { ServiceError, PILOT_LIMITS } from "./store.mjs";
import { SESSION_EVENT_TYPES } from "../src/work-item-session.js";

export const USAGE_DEFAULT_DAYS = 30;
export const USAGE_MAX_DAYS = 365;
const DAY_MS = 86400000;

// `?days=` is a whole number of days; values above the cap are clamped to it
// and the response reports the period actually used.
export function parseUsageDays(raw) {
  if (raw === null || raw === undefined) return USAGE_DEFAULT_DAYS;
  if (typeof raw !== "string" || !/^[1-9]\d{0,5}$/.test(raw))
    throw new ServiceError(422, "invalid_usage_period", `days must be a whole number of days from 1 to ${USAGE_MAX_DAYS}`);
  return Math.min(Number(raw), USAGE_MAX_DAYS);
}

const headroom = (used, limit) => ({ used, limit, remaining: Math.max(0, limit - used) });

// Folds the period's session events into attempts. A session.started opens a
// new attempt for its work item; later status changes and stops on that work
// item update the attempt's latest cumulative spend report. Spend reported in
// the period for an attempt that started before it is attributed to a carried
// attempt so a long-running session is not dropped from the period.
export function foldSessionEvents(rows) {
  const open = new Map();
  const attempts = [];
  let started = 0, stopped = 0, budgetStops = 0;
  const attemptFor = (workItemId, fresh) => {
    if (fresh || !open.has(workItemId)) {
      const attempt = { workItemId, spendCents: null };
      attempts.push(attempt);
      open.set(workItemId, attempt);
    }
    return open.get(workItemId);
  };
  for (const row of rows) {
    if (row.type === SESSION_EVENT_TYPES.STARTED) { started++; attemptFor(row.workItemId, true); }
    else if (row.type === SESSION_EVENT_TYPES.STOPPED) { stopped++; if (row.budgetEnforced === 1 || row.budgetEnforced === true) budgetStops++; }
    if (Number.isSafeInteger(row.spendCents) && row.spendCents >= 0) attemptFor(row.workItemId, false).spendCents = row.spendCents;
    if (row.type === SESSION_EVENT_TYPES.STOPPED) open.delete(row.workItemId);
  }
  const reported = attempts.filter(attempt => attempt.spendCents !== null);
  return {
    sessions: { started, stopped, budgetStops },
    spend: {
      reportedCents: reported.length ? reported.reduce((sum, attempt) => sum + attempt.spendCents, 0) : "unknown",
      sessionsReported: reported.length,
      sessionsUnreported: attempts.length - reported.length
    }
  };
}

export function roomUsageSummary(store, token, roomId, { days = USAGE_DEFAULT_DAYS, expectedSessionBinding = null } = {}) {
  return store.readTransaction(() => {
    store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const now = store.now();
    const since = new Date(now - days * DAY_MS).toISOString();
    const until = new Date(now).toISOString();
    const members = Object.values(room.state.members ?? {}).filter(Boolean);
    const active = members.filter(member => member.active !== false);
    const humans = active.filter(member => member.kind === "human").length;
    const agents = active.filter(member => member.kind === "agent").length;
    const agentIdentities = store.db.prepare("SELECT count(DISTINCT identity_id) AS n FROM identity_links WHERE room_id=?").get(roomId).n;
    const projectionBytes = store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS bytes FROM rooms WHERE id=?").get(roomId)?.bytes ?? 0;
    const rows = store.db.prepare(
      `SELECT json_extract(body,'$.type') AS type, json_extract(body,'$.data.workItemId') AS workItemId,
              json_extract(body,'$.data.spendCents') AS spendCents, json_extract(body,'$.data.budgetEnforced') AS budgetEnforced
       FROM events WHERE room_id=? AND json_extract(body,'$.type') IN (?,?,?) AND json_extract(body,'$.at')>=? ORDER BY sequence`
    ).all(roomId, SESSION_EVENT_TYPES.STARTED, SESSION_EVENT_TYPES.STATUS_CHANGED, SESSION_EVENT_TYPES.STOPPED, since);
    const folded = foldSessionEvents(rows);
    return {
      roomId,
      period: { days, since, until },
      members: { humans, agents, inactive: members.length - active.length, agentIdentities },
      sessions: folded.sessions,
      spend: folded.spend,
      caps: {
        members: headroom(members.length, PILOT_LIMITS.membersPerRoom),
        events: headroom(room.sequence, PILOT_LIMITS.eventsPerRoom),
        workItems: headroom(Object.keys(room.state.workItems ?? {}).length, PILOT_LIMITS.workItemsPerRoom),
        projectionBytes: headroom(projectionBytes, PILOT_LIMITS.projectionBytes)
      }
    };
  });
}
