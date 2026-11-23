// Read-only fact gatherer for agent-idle-state.mjs (docs/IDLE-TO-USEFUL-WORK.md).
//
// Collects, for one room's members, the facts the idle classifier needs from
// tables the Room already keeps. It never writes, creates a table, or reads a
// credential: webhook/push URLs are reduced to "configured" booleans and the
// push token/auth columns are never selected. A store missing an optional
// table (older or read-only opens) reads as "no such fact", never an error.
//
// Exact activity timestamps stay server-side. Route callers must expose only
// the coarse classification (see coarseIdleEntry), the same anti-
// fingerprinting rule as GET /api/wake-status.
import { classifyMember, deliveryFor } from "./agent-idle-state.mjs";
import { isCurrentRoom } from "./current-room-repository.mjs";
import { isScopedListenerHostId } from "./agent-heartbeats.mjs";

const ACTIVE_CLAIM_STATES = ["claimed", "in_progress", "blocked"];
// Same expression as work-claim-sqlite.mjs's inbox index, so the owner
// lookup can use work_claim_inbox_owner instead of decoding every claim.
const claimData = `(CASE WHEN json_type(item_json, '$.v') IN ('integer','real')
  THEN json_extract(item_json, '$.data') ELSE item_json END)`;

const isMissing = error => /no such (table|column)/i.test(String(error?.message ?? ""));
function tolerant(read, fallback) {
  try { return read(); } catch (error) { if (isMissing(error)) return fallback; throw error; }
}
const maxOf = (...values) => {
  const finite = values.filter(value => typeof value === "number" && Number.isFinite(value));
  return finite.length ? Math.max(...finite) : null;
};

// Members to classify: every agent identity linked to the room, plus human
// members from the room's member records. Returns [{ memberId, identityId, kind }].
export function roomMembersForIdle(db, roomId) {
  const agents = tolerant(() => db.prepare(
    "SELECT member_id AS memberId, identity_id AS identityId FROM identity_links WHERE room_id=? ORDER BY member_id").all(roomId), []);
  const humans = isCurrentRoom(db, roomId)
    ? tolerant(() => db.prepare(`SELECT record_key AS memberId FROM current_room_records
        WHERE room_id=? AND domain='members' AND json_extract(payload,'$.kind')='human'
          AND COALESCE(json_extract(payload,'$.active'),1)!=0 ORDER BY record_key LIMIT 200`).all(roomId), [])
    : tolerant(() => db.prepare(`SELECT j.key AS memberId FROM rooms r, json_each(r.projection,'$.members') j
        WHERE r.id=? AND json_valid(r.projection) AND json_extract(j.value,'$.kind')='human'
          AND COALESCE(json_extract(j.value,'$.active'),1)!=0 ORDER BY j.key LIMIT 200`).all(roomId), []);
  const linked = new Set(agents.map(row => row.memberId));
  return [
    ...agents.map(row => Object.freeze({ memberId: row.memberId, identityId: row.identityId, kind: "agent" })),
    ...humans.filter(row => !linked.has(row.memberId)).map(row => Object.freeze({ memberId: row.memberId, identityId: null, kind: "human" })),
  ];
}

function deliveryFacts(db, roomId, identityId) {
  if (!identityId) return {};
  const hosts = tolerant(() => db.prepare(
    "SELECT host_id AS hostId, mode, wake_url IS NOT NULL AND wake_url!='' AS hasWakeUrl, last_seen_at AS lastSeenAt FROM agent_hosts WHERE agent_id=?")
    .all(identityId), []);
  const pushes = tolerant(() => db.prepare(
    "SELECT cadence_seconds AS cadenceSeconds, push_url IS NOT NULL AND push_url!='' AS hasPushUrl, push_suspended AS suspended FROM agent_push_configs WHERE agent_id=?")
    .all(identityId), []);
  const poll = tolerant(() => db.prepare("SELECT last_polled_at AS at FROM agent_wake_polls WHERE agent_id=?").get(identityId), null);
  const roomActivity = tolerant(() => db.prepare(
    "SELECT last_polled_at AS at FROM agent_wake_room_activity WHERE agent_id=? AND room_id=?").get(identityId, roomId), null);
  // A listener holds either a room-scoped lease or an identity-wide one ('').
  const lease = tolerant(() => db.prepare(
    "SELECT MAX(lease_expires_at) AS at FROM agent_wake_listener_leases WHERE agent_id=? AND room_key IN (?, '')").get(identityId, roomId), null);
  const unacked = tolerant(() => db.prepare(
    "SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=? AND delivered_at IS NULL AND (room_id=? OR room_id IS NULL)").get(identityId, roomId), { n: 0 });
  const acked = tolerant(() => db.prepare(
    "SELECT MAX(delivered_at) AS at FROM agent_wake_signals WHERE agent_id=? AND (room_id=? OR room_id IS NULL)").get(identityId, roomId), null);
  const activePushes = pushes.filter(push => push.hasPushUrl);
  return {
    wakeUrl: hosts.some(host => host.hasWakeUrl) ? true : null,
    pushUrl: activePushes.length ? true : null,
    // Suspended only when every configured push is suspended and no wake URL
    // remains: one working channel keeps the member reachable.
    pushSuspended: activePushes.length > 0 && activePushes.every(push => push.suspended) && !hosts.some(host => host.hasWakeUrl),
    cadenceSeconds: maxOf(...pushes.map(push => push.cadenceSeconds)),
    lastPolledAt: poll?.at ?? null,
    // Scoped (room-key / room-bound API key) hosts are room-attributed
    // (CX5-FIX); their activity is read from agent_wake_room_activity.
    lastSeenAt: maxOf(...hosts.filter(host => !isScopedListenerHostId(host.hostId)).map(host => host.lastSeenAt)),
    // Room-scoped activity without an identity-level listener is what a
    // connector or stream-handoff reader (e.g. a Muse) leaves behind.
    streamSeenAt: roomActivity?.at ?? null,
    listenerLeaseExpiresAt: lease?.at ?? null,
    unackedWakes: unacked?.n ?? 0,
    lastAckedWakeAt: acked?.at ?? null,
  };
}

function workFacts(db, roomId, memberId, current) {
  const claims = tolerant(() => db.prepare(`SELECT json_extract(${claimData}, '$.leaseExpiresAt') AS leaseExpiresAt, updated_at AS updatedAt
      FROM work_claims WHERE room_id=? AND json_extract(${claimData}, '$.owner')=?
        AND json_extract(${claimData}, '$.state') IN (${ACTIVE_CLAIM_STATES.map(() => "?").join(",")}) LIMIT 50`)
    .all(roomId, memberId, ...ACTIVE_CLAIM_STATES), []);
  const lastClaim = tolerant(() => db.prepare(`SELECT MAX(updated_at) AS at FROM work_claims
      WHERE room_id=? AND json_extract(${claimData}, '$.owner')=?`).get(roomId, memberId), null);
  const openRequests = current
    ? tolerant(() => db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM current_room_records WHERE room_id=? AND domain='replyRequests'
        AND json_extract(payload,'$.status')='open' AND json_extract(payload,'$.recipientId')=? LIMIT 20)`).get(roomId, memberId), { n: 0 })
    : tolerant(() => db.prepare(`SELECT COUNT(*) AS n FROM rooms r, json_each(r.projection,'$.replyRequests') j
        WHERE r.id=? AND json_valid(r.projection) AND json_extract(j.value,'$.recipientId')=? AND json_extract(j.value,'$.status')='open'`)
      .get(roomId, memberId), { n: 0 });
  const paused = tolerant(() => db.prepare("SELECT 1 AS p FROM wake_queue_pause WHERE room_id=? AND member_id=?").get(roomId, memberId), null);
  return {
    openClaims: claims.map(row => ({ leaseExpiresAt: row.leaseExpiresAt ? Date.parse(row.leaseExpiresAt) : null })),
    lastClaimActivityAt: lastClaim?.at ?? null,
    openRequestsToMember: openRequests?.n ?? 0,
    memberPaused: !!paused,
  };
}

// Facts for one member, in the shape classifyMember expects.
export function memberIdleFacts(db, roomId, member, { current = isCurrentRoom(db, roomId) } = {}) {
  if (member.kind === "human") return { memberKind: "human" };
  return { ...deliveryFacts(db, roomId, member.identityId), ...workFacts(db, roomId, member.memberId, current) };
}

// Classify every member of a room. Server-side shape: includes idleMinutes.
export function roomIdleStates(db, roomId, nowMs) {
  const current = isCurrentRoom(db, roomId);
  return roomMembersForIdle(db, roomId).map(member => {
    const classification = classifyMember(memberIdleFacts(db, roomId, member, { current }), nowMs);
    return Object.freeze({ memberId: member.memberId, identityId: member.identityId, ...classification, delivery: deliveryFor(classification) });
  });
}

// What a route may expose: the coarse state and, for unreachable members, the
// reason an owner should look. No timestamps, no idle minutes, no channels.
export function coarseIdleEntry(entry) {
  return Object.freeze({
    state: entry.state,
    kind: entry.kind,
    ...(entry.delivery?.ownerLine ? { needsOwner: entry.reasons?.[0] ?? entry.delivery.reason } : {}),
  });
}
