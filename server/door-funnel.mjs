// Public door funnel: anonymous, counts-only weekly aggregates for the
// stranger door (DOOR-FUNNEL-READ, priced in PT-04 step 7 / C5-2).
//
// Why this exists: the new-member number was uncomputable for six straight
// weeks because no public aggregate read existed, even though both sources
// were already in the store —
//   joins: events of type member.added / member.joined_via_invitation,
//     timestamped at json_extract(body,'$.at') (ISO), the same shape
//     server/access-review.mjs already derives per-member join times from;
//   mints: agent_identities.created_at (INTEGER ms, NOT NULL), already used
//     internally for time-windowed mint counts.
// This module only aggregates those existing rows. No schema change, no
// stored state, computed at request time over a window capped at 12 weeks.
//
// Existence-hiding rules: counts only. No member id, identity id, display
// name, or joiner data ever leaves; rooms appear only when they are already
// listed in the public directory (read at request time, never hard-coded),
// and only under their already-public roomId. A listed room with no joins
// renders 0, never absence. A source failure refuses the whole read with
// door_funnel_unavailable rather than silently zeroing a leg.
//
// CLASSIFIER LIMITATION (explicit, not faked): joins are TOTALS. There is
// no fleet/outside split, because no reliable fleet marker exists in the
// join data — member.added carries kind (human/agent), accountableHumanId,
// identityId and agentType, none of which separates the operator's own
// fleets from outside joiners (outside agents are the door's whole point,
// and fleet members join as humans too). The result therefore carries
// classifier: { available: false, ... } in-band, so consumers print the
// limitation instead of a fabricated split. The deciding data change is a
// server-side fleet marker on the join event or the identity (priced in
// the PR body); until it lands, any non-fleet number stays an instrument-
// side classification over other surfaces, never this endpoint's claim.
//
// Weeks are Monday 00:00 America/Los_Angeles, matching the outside-signal
// instrument that consumes this read (its other numbers use the same
// local week). The module is dependency-free (local ServiceError, like
// server/room-directory.mjs) so it carries no import closure beyond itself.

export const DOOR_FUNNEL_SCHEMA = "project-room-door-funnel/1";
export const DOOR_FUNNEL_MAX_WEEKS = 12;
export const DOOR_FUNNEL_DEFAULT_WEEKS = 12;
export const DOOR_FUNNEL_TIME_ZONE = "America/Los_Angeles";

const JOIN_TYPES = Object.freeze(["member.added", "member.joined_via_invitation"]);
const DAY_MS = 86_400_000;

class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}
const unavailable = detail => {
  const error = new ServiceError(500, "door_funnel_unavailable", "Door funnel source is unavailable");
  if (detail) error.detail = detail;
  return error;
};

// ---- week math (Monday 00:00 America/Los_Angeles) -------------------------
const laFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: DOOR_FUNNEL_TIME_ZONE, weekday: "short",
  year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
});
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function laParts(ms) {
  const parts = {};
  for (const part of laFormat.formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

// The UTC instant of 00:00 local on a Los Angeles calendar date: guess the
// date as UTC midnight, read what local time that guess shows, and shift by
// the difference (two passes settle the DST-boundary cases).
function laMidnightUtcMs(year, month, day) {
  let guess = Date.UTC(year, month - 1, day);
  for (let i = 0; i < 2; i++) {
    const p = laParts(guess);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const target = Date.UTC(year, month - 1, day);
    const drift = shown - target;
    if (drift === 0) break;
    guess -= drift;
  }
  return guess;
}

// Monday (Los Angeles calendar date) of the week containing `ms`, plus the
// UTC start instant of that Monday and of the following Monday.
function mondayOf(ms) {
  const p = laParts(ms);
  const mondayUtcDate = Date.UTC(p.year, p.month - 1, p.day) - p.weekday * DAY_MS;
  const d = new Date(mondayUtcDate);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function addDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Oldest-first week buckets covering `count` weeks ending with the current
// (partial) week: [{ startsAtMs, endsAtMs }].
export function doorFunnelWeeks(now, count) {
  const current = mondayOf(now);
  const weeks = [];
  for (let back = count - 1; back >= 0; back--) {
    const start = addDays(current, -7 * back);
    const end = addDays(start, 7);
    weeks.push({
      startsAtMs: laMidnightUtcMs(start.year, start.month, start.day),
      endsAtMs: laMidnightUtcMs(end.year, end.month, end.day),
    });
  }
  return weeks;
}

export function clampDoorFunnelWeeks(value) {
  if (value == null || value === "") return DOOR_FUNNEL_DEFAULT_WEEKS;
  const n = Number(value);
  if (!Number.isFinite(n)) return DOOR_FUNNEL_DEFAULT_WEEKS;
  return Math.min(Math.max(Math.floor(n), 1), DOOR_FUNNEL_MAX_WEEKS);
}

// ---- aggregates -------------------------------------------------------------
// Pure over a db handle + the already-public listed-room set, so tests can
// drive it with a fixture store. `listedRooms`: [{ roomId }] in directory
// order. Throws door_funnel_unavailable on any source failure.
export function computeDoorFunnel(db, { listedRooms = [], weeks = DOOR_FUNNEL_DEFAULT_WEEKS, now = Date.now() } = {}) {
  if (!db || typeof db.prepare !== "function") throw unavailable("a db handle is required");
  const count = clampDoorFunnelWeeks(weeks);
  const buckets = doorFunnelWeeks(now, count);
  const firstStart = buckets[0].startsAtMs;
  const lastEnd = buckets[buckets.length - 1].endsAtMs;
  const roomIds = [...new Set(listedRooms.map(room => room?.roomId).filter(id => typeof id === "string" && id))];
  const out = buckets.map(bucket => ({
    startsAt: new Date(bucket.startsAtMs).toISOString(),
    joins: Object.fromEntries(roomIds.map(id => [id, 0])),
    mints: 0,
  }));
  const bucketIndex = ms => {
    for (let i = 0; i < buckets.length; i++) {
      if (ms >= buckets[i].startsAtMs && ms < buckets[i].endsAtMs) return i;
    }
    return -1;
  };
  try {
    if (roomIds.length) {
      const placeholders = roomIds.map(() => "?").join(",");
      const rows = db.prepare(`SELECT room_id AS roomId, json_extract(body,'$.at') AS at
        FROM events
        WHERE room_id IN (${placeholders})
          AND json_extract(body,'$.type') IN (?,?)
          AND json_extract(body,'$.at') >= ? AND json_extract(body,'$.at') < ?`)
        .all(...roomIds, ...JOIN_TYPES, new Date(firstStart).toISOString(), new Date(lastEnd).toISOString());
      for (const row of rows) {
        const at = typeof row.at === "string" ? Date.parse(row.at) : NaN;
        if (!Number.isFinite(at)) continue; // no usable join timestamp: not a countable join
        const i = bucketIndex(at);
        if (i >= 0 && Object.hasOwn(out[i].joins, row.roomId)) out[i].joins[row.roomId] += 1;
      }
    }
    const mintRows = db.prepare(`SELECT created_at AS createdAt FROM agent_identities
      WHERE created_at >= ? AND created_at < ?`).all(firstStart, lastEnd);
    for (const row of mintRows) {
      const at = Number(row.createdAt);
      if (!Number.isFinite(at)) continue;
      const i = bucketIndex(at);
      if (i >= 0) out[i].mints += 1;
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw unavailable(error?.message ?? String(error));
  }
  return out;
}

// The store-facing read used by the HTTP route. The listed-room set and the
// directory counts come from the public directory at request time — the
// same already-public data GET /api/public/rooms/directory serves.
export function readDoorFunnel(store, { weeks = DOOR_FUNNEL_DEFAULT_WEEKS, now = Date.now() } = {}) {
  if (!store || !store.db) throw unavailable("a store with a db handle is required");
  if (!store.roomDirectory || typeof store.roomDirectory.list !== "function") {
    throw unavailable("the public room directory is not attached to this store");
  }
  let listed;
  try {
    listed = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
      const result = store.roomDirectory.list({ after, limit: 100 });
      listed.push(...(result?.rooms ?? []));
      after = result?.nextCursor ?? null;
      if (!after) break;
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw unavailable(error?.message ?? String(error));
  }
  const weekRows = computeDoorFunnel(store.db, { listedRooms: listed, weeks, now });
  return {
    schema: DOOR_FUNNEL_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    weeks: weekRows,
    directory: {
      listedRooms: listed.length,
      totalMembers: listed.reduce((sum, room) => sum + (Number.isFinite(room?.memberCount) ? room.memberCount : 0), 0),
      rooms: listed.map(room => ({ roomId: room.roomId, memberCount: room.memberCount })),
    },
    classifier: {
      available: false,
      reason: "No fleet marker exists in the join data (member kind, sponsor, or identity fields do not separate operator fleets from outside joiners), so joins are reported as totals only; no fleet/outside split is claimed.",
    },
  };
}
