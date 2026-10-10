// FIX-19 (WAVE-300 ranked-fixes): correlated-death HOLD —
// "≥30% squad or ≥15 room-wide silent → 30-min park."
//
// Trigger path observed: 3+ daemon restarts killed ~46 lane-instances. When a
// squad (or the room) goes mass-silent at once, new claim *intake* is parked
// for 30 minutes: existing claims keep working, only NEW claims are refused
// with 503 correlated_death_hold.
//
// This is the automatic, detector-driven cousin of the FIX-66 STORM
// kill-switch (docs/KILL-SWITCH.md): the HOLD parks new claims when the
// detector fires; the kill-switch freezes every claim mutation when the room
// owner pulls it. They compose — the kill-switch is checked first and wins
// while engaged; the HOLD never freezes in-flight work and auto-releases.
//
// Silence reuses the FIX-67 presence activity signal *by definition*: a member
// is silent when they have no server-journaled authenticated command and no
// executing-session heartbeat within the presence TTL
// (HEARTBEAT_STALE_AFTER_MS = 180s). Enrollment (member.added) is deliberately
// NOT activity — same as FIX-67.
//
// Fail-safe by construction (like the kill-switch): the park state is
// in-memory only, per room, and never persisted. A crashed or restarted
// server always comes back un-parked. The detector re-evaluates on every new
// claim attempt, so a still-dead room re-parks on the next intake; a
// recovered room proceeds. A broken detector fails OPEN — intake is never
// blocked by signal errors.
import { HEARTBEAT_STALE_AFTER_MS } from "./agent-heartbeats.mjs";
import { sessionRecord } from "../src/work-item-session.js";
import { ServiceError } from "./service-error.mjs";

export const CORRELATED_DEATH_HOLD_CODE = "correlated_death_hold";
export const CORRELATED_DEATH_HOLD_MESSAGE =
  "New claim intake is parked: too many members went silent at once (possible correlated agent death). Existing claims keep working; only new claims are refused while parked.";

// Theoretical tunables (the playbook's thresholds are theory, not measured —
// see docs/WORK-CLAIMS.md "Correlated-death HOLD"). Do not treat these as
// calibrated constants.
export const CORRELATED_DEATH_SQUAD_SILENCE_FRACTION = 0.30;
export const CORRELATED_DEATH_ROOM_SILENCE_COUNT = 15;
export const CORRELATED_DEATH_PARK_MS = 30 * 60 * 1000;
export const CORRELATED_DEATH_SILENCE_TTL_MS = HEARTBEAT_STALE_AFTER_MS;

// In-memory only. A new instance (process restart, new store) is always
// un-parked. Lazily attached to the store by assertNoCorrelatedDeathHold so
// this module needs no RoomStore constructor change.
export function createCorrelatedDeathState() {
  const engagedUntil = new Map(); // roomId -> epoch ms the park lapses
  return {
    engagedUntilMs(roomId) {
      const value = engagedUntil.get(roomId);
      return Number.isFinite(value) ? value : null;
    },
    engage(roomId, untilMs) {
      if (typeof roomId === "string" && Number.isFinite(untilMs)) engagedUntil.set(roomId, untilMs);
    },
    release(roomId) {
      engagedUntil.delete(roomId);
    },
  };
}

const asTimestamp = value =>
  typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;

// The FIX-67 presence activity signal, pure form: last activity is the max of
// the server-journaled authenticated command timestamp and the
// executing-session heartbeat (never a client-reported timestamp; never a
// future timestamp). Returns null when there is no activity at all.
export function memberActivityAtMs(memberId, lastCommandAt, heartbeats, nowMs) {
  const commandAt = asTimestamp(lastCommandAt?.get(memberId)) || 0;
  const heartbeatAt = asTimestamp(heartbeats?.get(memberId));
  const sessionAt = heartbeatAt <= nowMs ? heartbeatAt || 0 : 0;
  const at = Math.max(commandAt, sessionAt);
  return at > 0 && at <= nowMs ? at : null;
}

export function activityMap(memberIds, lastCommandAt, heartbeats, nowMs) {
  const out = new Map();
  for (const id of memberIds ?? []) {
    const at = memberActivityAtMs(id, lastCommandAt, heartbeats, nowMs);
    if (at !== null) out.set(id, at);
  }
  return out;
}

// Pure: is this member silent right now? Missing from the activity map means
// no authenticated activity (or session heartbeat) within the TTL.
export function isMemberSilent(memberId, activityAt, nowMs, silenceTtlMs = CORRELATED_DEATH_SILENCE_TTL_MS) {
  const at = activityAt instanceof Map ? activityAt.get(memberId) : activityAt?.[memberId];
  const ts = asTimestamp(at);
  return !(ts > 0 && ts <= nowMs && nowMs - ts <= silenceTtlMs);
}

// Pure detector. memberIds: active room member ids. squads: [{ id, name,
// members }] over ACTIVE squads with ACTIVE members only. activityAt: Map of
// memberId -> last activity epoch ms. Returns { hold, reason, ... } — reason
// is "squad" or "room".
export function evaluateCorrelatedDeathHold({
  memberIds = [],
  squads = [],
  activityAt = new Map(),
  nowMs = Date.now(),
  squadSilenceFraction = CORRELATED_DEATH_SQUAD_SILENCE_FRACTION,
  roomSilenceCount = CORRELATED_DEATH_ROOM_SILENCE_COUNT,
  silenceTtlMs = CORRELATED_DEATH_SILENCE_TTL_MS,
} = {}) {
  const silent = id => isMemberSilent(id, activityAt, nowMs, silenceTtlMs);
  for (const squad of squads ?? []) {
    const ids = [...new Set(Array.isArray(squad?.members) ? squad.members : [])];
    if (ids.length === 0) continue;
    const silentCount = ids.filter(silent).length;
    if (silentCount / ids.length >= squadSilenceFraction) {
      return { hold: true, reason: "squad", squadId: squad.id ?? null, squadName: squad.name ?? null,
        silentCount, memberCount: ids.length, fraction: silentCount / ids.length };
    }
  }
  const roomIds = [...new Set(memberIds ?? [])];
  const roomSilent = roomIds.filter(silent).length;
  if (roomSilent >= roomSilenceCount) {
    return { hold: true, reason: "room", silentCount: roomSilent, memberCount: roomIds.length };
  }
  return { hold: false, silentCount: roomSilent, memberCount: roomIds.length };
}

// Store signal, mirroring FIX-67's queries exactly: per-actor max `at` from
// the server-journaled events table (every authenticated command is journaled
// with actorId by command()), plus per-worker max session heartbeat_at from
// executing work items.
function readLastCommandAt(db, roomId) {
  const rows = db.prepare(
    `SELECT json_extract(body,'$.actorId') AS actor, max(json_extract(body,'$.at')) AS at
     FROM events WHERE room_id=? GROUP BY actor`
  ).all(roomId);
  return new Map(rows.filter(row => row?.actor).map(row => [row.actor, row.at]));
}

function readSessionHeartbeats(store, roomId) {
  const out = new Map();
  let workItems = {};
  try {
    workItems = store.room(roomId)?.state?.workItems ?? {};
  } catch {
    return out;
  }
  for (const item of Object.values(workItems)) {
    let session = null;
    try {
      session = sessionRecord(item);
    } catch {
      continue;
    }
    if (session?.worker_member_id && session.heartbeat_at) {
      const prev = out.get(session.worker_member_id);
      if (!prev || session.heartbeat_at > prev) out.set(session.worker_member_id, session.heartbeat_at);
    }
  }
  return out;
}

function readActiveSquads(store, roomId, members) {
  const squads = [];
  let rows = [];
  try {
    rows = store.db.prepare(
      "SELECT squad_id, name, members_json FROM squads WHERE room_id=? AND state='active'"
    ).all(roomId);
  } catch {
    return squads; // no squads table (older fixture) — the room trigger still applies
  }
  for (const row of rows) {
    let ids = [];
    try {
      const parsed = JSON.parse(row.members_json);
      if (Array.isArray(parsed)) ids = parsed.filter(id => typeof id === "string");
    } catch {
      ids = [];
    }
    squads.push({
      id: row.squad_id,
      name: row.name ?? null,
      members: [...new Set(ids)].filter(id => members?.[id]?.active !== false),
    });
  }
  return squads;
}

function storeHoldState(store) {
  if (!store.correlatedDeath || typeof store.correlatedDeath.engagedUntilMs !== "function") {
    store.correlatedDeath = createCorrelatedDeathState();
  }
  return store.correlatedDeath;
}

function holdRefusal(remainingMs, verdict) {
  const error = new ServiceError(503, CORRELATED_DEATH_HOLD_CODE, CORRELATED_DEATH_HOLD_MESSAGE);
  error.body = {
    error: { code: CORRELATED_DEATH_HOLD_CODE, message: CORRELATED_DEATH_HOLD_MESSAGE },
    hint: "A squad (≥30% silent) or the room (≥15 silent) went quiet at once — possible correlated agent death. Intake is parked for 30 minutes; existing claims and reads are unaffected.",
    next: "Wait out the park, or have members resume authenticated activity; the detector re-evaluates on every new-claim attempt and releases automatically.",
    hold: {
      remainingMs,
      reason: verdict?.reason ?? "parked",
      silentCount: verdict?.silentCount ?? null,
      ...(verdict?.reason === "squad" ? { squadId: verdict.squadId, squadName: verdict.squadName } : {}),
    },
  };
  return error;
}

// Throwing guard for the new-claim intake path. Engages the 30-minute park
// when the detector trips and throws 503 correlated_death_hold while parked.
// Fail-open: any signal failure returns silently — a broken detector never
// blocks claim intake.
export function assertNoCorrelatedDeathHold(store, roomId) {
  try {
    const nowMs = typeof store?.now === "function" ? store.now() : Date.now();
    const state = storeHoldState(store);
    const until = state.engagedUntilMs(roomId);
    if (until !== null) {
      if (nowMs < until) throw holdRefusal(until - nowMs, null);
      state.release(roomId); // the park lapsed — fall through and re-evaluate
    }
    const members = store.roomAuthority(roomId).members ?? {};
    const memberIds = Object.values(members)
      .filter(m => m && m.active !== false && typeof m.id === "string")
      .map(m => m.id);
    const activityAt = activityMap(
      memberIds,
      readLastCommandAt(store.db, roomId),
      readSessionHeartbeats(store, roomId),
      nowMs
    );
    const verdict = evaluateCorrelatedDeathHold({
      memberIds,
      squads: readActiveSquads(store, roomId, members),
      activityAt,
      nowMs,
    });
    if (verdict.hold) {
      state.engage(roomId, nowMs + CORRELATED_DEATH_PARK_MS);
      throw holdRefusal(CORRELATED_DEATH_PARK_MS, verdict);
    }
  } catch (error) {
    if (error?.code === CORRELATED_DEATH_HOLD_CODE) throw error;
    return; // fail-open
  }
}

// Read helper for status surfaces and tests: is intake currently parked?
export function correlatedDeathStatus(store, roomId) {
  try {
    const nowMs = typeof store?.now === "function" ? store.now() : Date.now();
    const until = store?.correlatedDeath?.engagedUntilMs?.(roomId) ?? null;
    if (until !== null && nowMs < until) {
      return { engaged: true, engagedUntilMs: until, remainingMs: until - nowMs };
    }
    return { engaged: false, engagedUntilMs: null, remainingMs: 0 };
  } catch {
    return { engaged: false, engagedUntilMs: null, remainingMs: 0 };
  }
}
