// CP-AGENTS-1: fleet read model. One row per agent member of a room, built
// only from existing read models: the room projection (members, halts, work
// items and their sessions), the Board (work_claims), the event log (last
// event per actor), the wake queue and its pause table, and the autonomy tier
// table. Nothing here writes.
//
// Fields that depend on batches that have not landed stay honest:
//   - waiting_for_you (AX-1 input_required / CP-APPROVALS) and stuck (AX-3)
//     are never produced yet;
//   - receiving is null: no observed receive evidence is stored (R's receive
//     qualification is a script), and a heartbeat alone never counts;
//   - budget is null and over_budget is never produced: there is no per-agent
//     spend cap (server/autonomy-tiers.mjs);
//   - lastProgress is null until AX-1 claim activity exists.

import { getTier } from "./autonomy-tiers.mjs";
import { isRunningSession, sessionRecord } from "../src/work-item-session.js";

export const FLEET_STATES = Object.freeze(["removed", "halted", "read_only", "over_budget", "paused", "waiting_for_you", "stuck", "working", "idle"]);
const ACTIVE_CLAIM_STATES = new Set(["claimed", "in_progress", "blocked"]);
const DAY_MS = 86_400_000;
const SPEND_DAYS = 7;
const OUTCOME_DAYS = 30;

const ms = value => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

// Exactly one primary state, by FLEET_STATES precedence.
export function primaryState(flags) {
  for (const state of FLEET_STATES) if (flags[state]) return state;
  return "idle";
}

function lastEventsByActor(db, roomId, actorIds) {
  if (!actorIds.length) return new Map();
  // One grouped pass over the room's events, then one keyed read for the
  // winning rows. No index on actor exists; the room_id primary-key prefix
  // bounds the scan to this room.
  const latest = db.prepare(`SELECT json_extract(body,'$.actorId') AS actor, max(sequence) AS seq FROM events
    WHERE room_id=? GROUP BY actor`).all(roomId).filter(row => actorIds.includes(row.actor));
  if (!latest.length) return new Map();
  const rows = db.prepare(`SELECT sequence AS seq, json_extract(body,'$.type') AS type, json_extract(body,'$.at') AS at
    FROM events WHERE room_id=? AND sequence IN (${latest.map(() => "?").join(",")})`).all(roomId, ...latest.map(row => row.seq));
  const bySeq = new Map(rows.map(row => [row.seq, row]));
  return new Map(latest.map(row => [row.actor, bySeq.get(row.seq) ?? null]));
}

function wakeState(db, roomId) {
  const paused = new Map();
  const queued = new Map();
  const dead = new Map();
  try {
    for (const row of db.prepare("SELECT member_id, paused_at, reason FROM wake_queue_pause WHERE room_id=?").all(roomId)) paused.set(row.member_id, row);
    for (const row of db.prepare("SELECT member_id, state, count(*) AS n FROM wake_queue WHERE room_id=? AND state IN ('pending','leased','dead') GROUP BY member_id, state").all(roomId)) {
      const target = row.state === "dead" ? dead : queued;
      target.set(row.member_id, (target.get(row.member_id) ?? 0) + row.n);
    }
  } catch { /* a store without the wake queue reports nothing queued */ }
  return { paused, queued, dead };
}

function tierOf(db, roomId, memberId) {
  try { return getTier(db, roomId, memberId)?.autonomyTier ?? "t2_standard"; }
  catch { return "t2_standard"; }
}

function spendFor(state, memberId, nowMs) {
  const since = nowMs - SPEND_DAYS * DAY_MS;
  const spend = { periodDays: SPEND_DAYS, spentCents: 0, toolCalls: 0, sessions: 0 };
  let working = false;
  for (const item of Object.values(state.workItems ?? {})) {
    if (!item || typeof item !== "object") continue;
    const session = sessionRecord(item);
    for (const attempt of session.attempts) {
      if (attempt.performer !== memberId) continue;
      const end = attempt.endedAt === null ? nowMs : ms(attempt.endedAt);
      if (end === null || end < since) continue;
      spend.sessions++;
      if (attempt.endedAt !== null && attempt.usageCents !== null) spend.spentCents += attempt.usageCents;
    }
    if (session.worker_member_id === memberId && isRunningSession(session.status)) {
      working = true;
      if (session.spend_cents !== null) spend.spentCents += session.spend_cents;
      spend.toolCalls += session.tool_calls;
    }
  }
  return { spend, working };
}

function outcomesFor(claims, memberId, nowMs) {
  const since = nowMs - OUTCOME_DAYS * DAY_MS;
  const outcomes = { claimsDone: 0, reviewsApproved: 0, changesRequested: 0, reopened: 0 };
  for (const claim of claims) {
    if (claim.owner !== memberId) continue;
    const history = Array.isArray(claim.history) ? claim.history : [];
    let sawDone = false;
    for (const entry of history) {
      const at = ms(entry?.at);
      if (entry?.action === "state:done") {
        sawDone = true;
        if (at !== null && at >= since) outcomes.claimsDone++;
      } else if (sawDone && at !== null && at >= since && (entry?.action === "claimed" || entry?.action === "state:in_progress")) {
        outcomes.reopened++;
        sawDone = false;
      }
    }
    for (const review of Array.isArray(claim.reviews) ? claim.reviews : []) {
      const at = ms(review?.at);
      if (at === null || at < since) continue;
      if (review.verdict === "approve") outcomes.reviewsApproved++;
      else if (review.verdict === "changes_requested") outcomes.changesRequested++;
    }
  }
  return outcomes;
}

function currentClaimOf(claims, memberId) {
  const active = claims.filter(claim => claim.owner === memberId && ACTIVE_CLAIM_STATES.has(claim.state));
  active.sort((a, b) => (ms(b.claimedAt) ?? 0) - (ms(a.claimedAt) ?? 0));
  const claim = active[0];
  return claim ? { claimId: claim.id, title: claim.title ?? claim.id, state: claim.state, leaseExpiresAt: claim.leaseExpiresAt ?? null, untrusted: true } : null;
}

// Who may read which rows: the room owner and delegated admins see every
// agent; a human sees the agents they sponsor; anyone else is refused.
export function fleetScope(state, viewerId) {
  const viewer = state.members?.[viewerId];
  if (!viewer || viewer.active === false) return null;
  if (state.room?.ownerId === viewerId || viewer.delegatedAdmin === true) return { all: true };
  if (viewer.kind !== "human") return null;
  const sponsored = Object.values(state.members ?? {}).some(member => member?.kind === "agent" && member.accountableHumanId === viewerId && member.id !== viewerId);
  return sponsored ? { all: false, sponsorId: viewerId } : null;
}

// Rows for every agent the scope allows. `room` is store.room(roomId) so the
// caller controls the single projection read.
export function fleetRows(store, roomId, room, { memberIds = null } = {}) {
  const { state } = room;
  const nowMs = store.now();
  const agents = Object.values(state.members ?? {})
    .filter(member => member && member.kind === "agent" && (!memberIds || memberIds.includes(member.id)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let claims = [];
  try { claims = store.workClaims?.list?.(roomId) ?? []; } catch { claims = []; }
  const lastEvents = lastEventsByActor(store.db, roomId, agents.map(member => member.id));
  const wakes = wakeState(store.db, roomId);
  return agents.map(member => {
    const sponsorMember = member.accountableHumanId && member.accountableHumanId !== member.id ? state.members?.[member.accountableHumanId] : null;
    const tier = tierOf(store.db, roomId, member.id);
    const halt = state.agentHalts?.[member.id] ?? null;
    const pause = wakes.paused.get(member.id) ?? null;
    const currentClaim = currentClaimOf(claims, member.id);
    const { spend, working: sessionWorking } = spendFor(state, member.id, nowMs);
    const last = lastEvents.get(member.id) ?? null;
    const state_ = primaryState({
      removed: member.active === false,
      halted: Boolean(halt),
      read_only: tier === "t1_readonly",
      paused: Boolean(pause),
      working: Boolean(currentClaim) || sessionWorking
    });
    const badges = [];
    if (member.delegatedAdmin === true) badges.push("delegated_admin");
    if (member.system === true) badges.push("system");
    if (currentClaim?.state === "blocked") badges.push("claim_blocked");
    if (currentClaim?.leaseExpiresAt && (ms(currentClaim.leaseExpiresAt) ?? Infinity) <= nowMs) badges.push("lease_expired");
    if ((wakes.dead.get(member.id) ?? 0) > 0) badges.push("wake_failed");
    return {
      memberId: member.id,
      displayName: member.displayName,
      sponsor: sponsorMember ? { memberId: sponsorMember.id, displayName: sponsorMember.displayName } : null,
      profile: { kind: member.kind, agentType: member.agentType ?? null, identityId: member.identityId ?? null },
      tier,
      permissions: [...(member.permissions ?? [])],
      state: state_,
      badges,
      currentClaim,
      lastAction: last ? { seq: last.seq, type: last.type, at: last.at } : null,
      lastProgress: null,
      receiving: null,
      wake: { paused: Boolean(pause), pausedBy: null, reason: pause?.reason ?? null, queued: wakes.queued.get(member.id) ?? 0 },
      spend,
      budget: null,
      outcomes: outcomesFor(claims, member.id, nowMs),
      ...(halt ? { halt: { at: halt.at ?? null, reason: halt.reason ?? null } } : {})
    };
  });
}

export function fleetFor(store, auth, roomId) {
  const room = store.room(roomId);
  const scope = fleetScope(room.state, auth.member.id);
  if (!scope) return null;
  const memberIds = scope.all ? null : Object.values(room.state.members ?? {})
    .filter(member => member?.kind === "agent" && member.accountableHumanId === scope.sponsorId)
    .map(member => member.id);
  return {
    roomId,
    evaluatedThrough: room.sequence,
    scope: scope.all ? "room" : "sponsored",
    agents: fleetRows(store, roomId, room, { memberIds }),
    generatedAt: new Date(store.now()).toISOString()
  };
}

// The calling agent's own summary for room_orient (`you`).
export function fleetSelf(store, roomId, room, memberId) {
  const [row] = fleetRows(store, roomId, room, { memberIds: [memberId] });
  return row ? { state: row.state, badges: row.badges, budget: row.budget } : null;
}
