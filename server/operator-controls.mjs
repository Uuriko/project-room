// Operator attachment prerequisites (slice 1/3): per-agent spend caps, a
// per-agent kill switch, and graduated autonomy tiers.
//
// Thesis: an operator attaches to an agent only when the blast radius is
// bounded. These controls are keyed by (room_id, member_id) — room-local,
// matching room sovereignty — and live in a side table read FRESH on every
// command, so a kill propagates immediately and always wins (fail-closed).
// Nothing is cached. The defaults are migration-safe: no row means no
// behavior change until the operator acts.
//
// This module does not import server/store.mjs (store imports it); errors
// carry status and code like ServiceError and the router reads them as such.
import { EVENT_TYPES as T, SPEND_ALLOWANCE_LIMITS } from "../src/events.js";
import { sessionRecord, isRunningSession } from "../src/work-item-session.js";

export const OPERATOR_CONTROLS_DEFAULT_PERIOD_DAYS = 30;
export const OPERATOR_CONTROLS_MAX_PERIOD_DAYS = 365;
export const AUTONOMY_TIERS = Object.freeze(["t1_readonly", "t2_standard"]);
export const DEFAULT_AUTONOMY_TIER = "t2_standard";

// t1_readonly agents may not change room state at all, except the session
// report/stop family: heartbeats and spend reports keep landing (a readonly
// agent still reports what it spent), and stops always land so actual spend
// is recorded. The set is explicit and closed — a command type not listed
// here is refused for t1 agents.
export const T1_READONLY_ALLOWED_COMMANDS = Object.freeze(new Set([
  T.SESSION_STATUS_CHANGED, // heartbeats + spend reports
  T.SESSION_STOP_REQUESTED,
  T.SESSION_STOPPED,        // stops always land
]));

// Room-local operator controls. Created lazily by the first operator write;
// absent row = defaults (t2_standard, no cap, not killed).
export const OPERATOR_CONTROLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_operator_controls (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  spend_cap_cents INTEGER NULL,
  spend_period_days INTEGER NOT NULL DEFAULT 30,
  killed_at INTEGER NULL,
  autonomy_tier TEXT NOT NULL DEFAULT 't2_standard',
  sandboxed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NULL,
  updated_by TEXT NULL,
  PRIMARY KEY (room_id, member_id)
);`;

// Called from the writer boot path (next to ensureIdentitySecretSchema in
// server/store.mjs), not the constructor: the table is purely additive, so
// no schema version bump. IF NOT EXISTS is idempotent.
export function ensureOperatorControlsSchema(db) {
  db.exec(OPERATOR_CONTROLS_SCHEMA);
}

export class OperatorControlsError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new OperatorControlsError(status, code, message); };
const dollars = cents => `$${(cents / 100).toFixed(2)}`;

const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const validMemberId = id => typeof id === "string" && MEMBER_ID_PATTERN.test(id);

function rowToControls(row) {
  if (!row) return null;
  return Object.freeze({
    roomId: row.room_id,
    memberId: row.member_id,
    spendCapCents: row.spend_cap_cents ?? null,
    spendPeriodDays: row.spend_period_days ?? OPERATOR_CONTROLS_DEFAULT_PERIOD_DAYS,
    killedAt: row.killed_at ?? null,
    autonomyTier: row.autonomy_tier ?? DEFAULT_AUTONOMY_TIER,
    sandboxed: row.sandboxed === 1,
    updatedAt: row.updated_at ?? null,
    updatedBy: row.updated_by ?? null,
  });
}

// Fresh read, every time: no caching anywhere on this path.
export function getControls(db, roomId, memberId) {
  const row = db.prepare("SELECT * FROM agent_operator_controls WHERE room_id=? AND member_id=?").get(roomId, memberId);
  return rowToControls(row);
}

function validateCap(spendCapCents) {
  if (spendCapCents === null) return null;
  if (!Number.isSafeInteger(spendCapCents) || spendCapCents < 1 || spendCapCents > SPEND_ALLOWANCE_LIMITS.allowanceCents)
    refuse(422, "invalid_operator_controls", `spendCapCents must be a positive integer of cents from 1 to ${SPEND_ALLOWANCE_LIMITS.allowanceCents}, or null to remove the cap`);
  return spendCapCents;
}
function validatePeriod(spendPeriodDays) {
  if (!Number.isSafeInteger(spendPeriodDays) || spendPeriodDays < 1 || spendPeriodDays > OPERATOR_CONTROLS_MAX_PERIOD_DAYS)
    refuse(422, "invalid_operator_controls", `spendPeriodDays must be an integer from 1 to ${OPERATOR_CONTROLS_MAX_PERIOD_DAYS}`);
  return spendPeriodDays;
}
function validateTier(autonomyTier) {
  if (!AUTONOMY_TIERS.includes(autonomyTier))
    refuse(422, "invalid_operator_controls", `autonomyTier must be one of ${AUTONOMY_TIERS.join(", ")}`);
  return autonomyTier;
}
function validateSandboxed(sandboxed) {
  if (typeof sandboxed !== "boolean")
    refuse(422, "invalid_operator_controls", "sandboxed must be a boolean");
  return sandboxed ? 1 : 0;
}

// Partial update of the controls row; unspecified fields keep their values.
// Throws 422 invalid_operator_controls on bad input. Returns the frozen row.
export function setControls(db, roomId, memberId, patch, { updatedBy = null, nowMs = Date.now() } = {}) {
  if (!validMemberId(memberId)) refuse(422, "invalid_operator_controls", "memberId must be a room member id");
  if (!patch || Array.isArray(patch) || typeof patch !== "object") refuse(422, "invalid_operator_controls", "Supply a controls object");
  const keys = Object.keys(patch);
  const known = ["spendCapCents", "spendPeriodDays", "autonomyTier", "sandboxed"];
  if (!keys.length || keys.some(key => !known.includes(key)))
    refuse(422, "invalid_operator_controls", `Supply at least one of ${known.join(", ")}`);
  const current = getControls(db, roomId, memberId);
  const cap = "spendCapCents" in patch ? validateCap(patch.spendCapCents) : (current?.spendCapCents ?? null);
  const period = "spendPeriodDays" in patch ? validatePeriod(patch.spendPeriodDays) : (current?.spendPeriodDays ?? OPERATOR_CONTROLS_DEFAULT_PERIOD_DAYS);
  const tier = "autonomyTier" in patch ? validateTier(patch.autonomyTier) : (current?.autonomyTier ?? DEFAULT_AUTONOMY_TIER);
  const sandbox = "sandboxed" in patch ? validateSandboxed(patch.sandboxed) : (current?.sandboxed ? 1 : 0);
  db.prepare(`INSERT INTO agent_operator_controls
      (room_id, member_id, spend_cap_cents, spend_period_days, killed_at, autonomy_tier, sandboxed, updated_at, updated_by)
      VALUES (?, ?, ?, ?, COALESCE((SELECT killed_at FROM agent_operator_controls WHERE room_id=? AND member_id=?), NULL), ?, ?, ?, ?)
      ON CONFLICT(room_id, member_id) DO UPDATE SET
        spend_cap_cents=excluded.spend_cap_cents, spend_period_days=excluded.spend_period_days,
        autonomy_tier=excluded.autonomy_tier, sandboxed=excluded.sandboxed,
        updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(roomId, memberId, cap, period, roomId, memberId, tier, sandbox, nowMs, updatedBy);
  return getControls(db, roomId, memberId);
}

// The kill switch: an operator parks the agent immediately. Idempotent —
// killing an already-killed agent just refreshes the timestamp.
export function killAgent(db, roomId, memberId, { updatedBy = null, nowMs = Date.now() } = {}) {
  if (!validMemberId(memberId)) refuse(422, "invalid_operator_controls", "memberId must be a room member id");
  db.prepare(`INSERT INTO agent_operator_controls
      (room_id, member_id, killed_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(room_id, member_id) DO UPDATE SET killed_at=excluded.killed_at, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(roomId, memberId, nowMs, nowMs, updatedBy);
  return getControls(db, roomId, memberId);
}

export function reviveAgent(db, roomId, memberId, { updatedBy = null, nowMs = Date.now() } = {}) {
  if (!validMemberId(memberId)) refuse(422, "invalid_operator_controls", "memberId must be a room member id");
  const current = getControls(db, roomId, memberId);
  if (!current) return null;
  db.prepare("UPDATE agent_operator_controls SET killed_at=NULL, updated_at=?, updated_by=? WHERE room_id=? AND member_id=?")
    .run(nowMs, updatedBy, roomId, memberId);
  return getControls(db, roomId, memberId);
}

export function setSpendCap(db, roomId, memberId, spendCapCents, opts = {}) {
  return setControls(db, roomId, memberId, { spendCapCents }, opts);
}

export function setTier(db, roomId, memberId, autonomyTier, opts = {}) {
  return setControls(db, roomId, memberId, { autonomyTier }, opts);
}

// Per-agent measured spend ledger. Mirrors spendLedger (src/work-item-session.js)
// but attributes to one member: closed attempts by attempt.performer, live
// sessions by worker_member_id. MEASURED ONLY — never estimates: spend
// figures come from usageCents the agent reported, reservations from declared
// caps, and unreported-but-capped attempts stay held at their cap so unknown
// spend can never free a cap for the next start.
export function agentSpendLedger(state, memberId, { nowMs = Date.now(), periodDays = OPERATOR_CONTROLS_DEFAULT_PERIOD_DAYS } = {}) {
  const since = nowMs - periodDays * 86400000;
  const ledger = {
    periodDays, since: new Date(since).toISOString(), until: new Date(nowMs).toISOString(),
    spentCents: 0, reservedCents: 0, heldCents: 0, committedCents: 0,
    sessions: { live: 0, unreserved: 0, attemptsCounted: 0, attemptsUnreported: 0, attemptsHeld: 0 },
  };
  for (const item of Object.values(state?.workItems ?? {})) {
    if (!item || typeof item !== "object") continue;
    const session = sessionRecord(item);
    for (const attempt of session.attempts) {
      if (attempt.performer !== memberId) continue;
      if (attempt.endedAt === null) continue; // the open attempt rides the live session below
      if (Date.parse(attempt.endedAt) < since) continue;
      ledger.sessions.attemptsCounted++;
      if (attempt.usageCents !== null) ledger.spentCents += attempt.usageCents;
      else if (Number.isSafeInteger(attempt.limits?.maxSpendCents)) { ledger.heldCents += attempt.limits.maxSpendCents; ledger.sessions.attemptsHeld++; }
      else ledger.sessions.attemptsUnreported++;
    }
    if (!isRunningSession(session.status)) continue;
    if (session.worker_member_id !== memberId) continue;
    ledger.sessions.live++;
    ledger.sessions.attemptsCounted++;
    const reported = session.spend_cents; // a live run that has not reported yet is covered by its reservation
    if (reported !== null) ledger.spentCents += reported;
    const cap = session.budget?.maxSpendCents ?? null;
    if (cap === null) ledger.sessions.unreserved++;
    else ledger.reservedCents += Math.max(0, cap - (reported ?? 0));
  }
  ledger.committedCents = ledger.spentCents + ledger.reservedCents + ledger.heldCents;
  return ledger;
}

// The effective reservation of a session start: the declared budget, or on a
// retry that declares none, the budget the item already carries. Mirrors the
// room allowance: silence never widens a limit.
function startingSpendCap(item, data) {
  const session = sessionRecord(item);
  const retry = session.status !== "queued";
  const budget = data.budget == null && retry ? session.budget : data.budget;
  const cap = budget?.maxSpendCents;
  return Number.isSafeInteger(cap) && cap > 0 ? cap : null;
}

const memberName = (state, memberId) => state?.members?.[memberId]?.displayName ?? memberId;

function capSummary(controls, ledger) {
  return `${dollars(ledger.spentCents)} spent, ${dollars(ledger.reservedCents)} reserved and ${dollars(ledger.heldCents)} held for unreported attempts of a ${dollars(controls.spendCapCents)} cap over ${controls.spendPeriodDays} days`;
}

// Called by store.command() inside the write transaction, before the event
// is applied. Controls are read fresh from the table on every call — a kill
// in the table always wins, and the kill decision propagates immediately.
// `fail(status, code, message)` is the store's own thrower.
export function enforceOperatorControls({ db, roomId, state, command, actorId, nowMs = Date.now(), fail = refuse }) {
  if (!db || typeof roomId !== "string" || typeof actorId !== "string" || !command || typeof command.type !== "string") return;
  const controls = getControls(db, roomId, actorId);
  if (!controls) return; // no operator action: migration-safe default, no behavior change
  const name = memberName(state, actorId);
  if (controls.killedAt !== null)
    fail(403, "agent_killed", `${name} is stopped by the room operator: this agent's writes are refused until the operator revives it`);
  if (controls.autonomyTier === "t1_readonly" && !T1_READONLY_ALLOWED_COMMANDS.has(command.type))
    fail(403, "agent_readonly", `${name} runs at the read-only autonomy tier: it may read and report session status, but it cannot ${command.type}`);
  if (controls.spendCapCents === null) return;
  if (command.type !== T.SESSION_STARTED && command.type !== T.SESSION_STATUS_CHANGED) return;
  const item = state.workItems?.[command.data.workItemId];
  if (!item) return; // the applier reports the missing item
  const ledger = agentSpendLedger(state, actorId, { nowMs, periodDays: controls.spendPeriodDays });
  const summary = capSummary(controls, ledger);
  if (command.type === T.SESSION_STARTED) {
    const cap = startingSpendCap(item, command.data);
    if (cap === null) {
      fail(422, "agent_spend_cap_budget_required", `The operator set a spend cap for ${name} (${summary}): declare budget.maxSpendCents when the session starts so the room can reserve it against the cap; no session was started`);
    }
    if (ledger.committedCents + cap > controls.spendCapCents) {
      fail(409, "agent_spend_cap_exceeded", `The agent is parked at its cap: starting this session would reserve ${dollars(cap)} with ${summary} (${dollars(Math.max(0, controls.spendCapCents - ledger.committedCents))} left); no session was started`);
    }
    return;
  }
  // A running session's spend report may not carry the agent past its cap:
  // within its reservation the report changes nothing; beyond it, the
  // overage is refused and the session must stop (a stop always lands).
  const session = sessionRecord(item);
  if (!isRunningSession(session.status) || !Number.isSafeInteger(command.data.spendCents)) return;
  const budgetCap = session.budget?.maxSpendCents ?? null;
  const before = budgetCap === null ? (session.spend_cents ?? 0) : Math.max(budgetCap, session.spend_cents ?? 0);
  const after = budgetCap === null ? command.data.spendCents : Math.max(budgetCap, command.data.spendCents);
  if (after > before && ledger.committedCents + (after - before) > controls.spendCapCents) {
    fail(409, "agent_spend_cap_exceeded", `Reporting ${dollars(command.data.spendCents)} would carry ${name} past its spend cap (${summary}); stop the session to record the spend`);
  }
}

// Read model for the operator API: controls, derived status and measured spend.
export function operatorControlsReport(db, roomId, state, memberId, nowMs = Date.now()) {
  const controls = getControls(db, roomId, memberId);
  const periodDays = controls?.spendPeriodDays ?? OPERATOR_CONTROLS_DEFAULT_PERIOD_DAYS;
  const ledger = agentSpendLedger(state, memberId, { nowMs, periodDays });
  const parkedAtCap = controls?.spendCapCents !== null && controls?.spendCapCents !== undefined
    && ledger.committedCents >= controls.spendCapCents;
  return {
    roomId,
    memberId,
    controls: controls ? {
      spendCapCents: controls.spendCapCents,
      spendPeriodDays: controls.spendPeriodDays,
      killedAt: controls.killedAt,
      autonomyTier: controls.autonomyTier,
      sandboxed: controls.sandboxed,
      updatedAt: controls.updatedAt,
      updatedBy: controls.updatedBy,
    } : null,
    status: {
      killed: controls?.killedAt !== null && controls?.killedAt !== undefined,
      autonomyTier: controls?.autonomyTier ?? DEFAULT_AUTONOMY_TIER,
      spendCapCents: controls?.spendCapCents ?? null,
      parkedAtCap,
    },
    ledger,
    headroomCents: controls?.spendCapCents != null ? Math.max(0, controls.spendCapCents - ledger.committedCents) : null,
  };
}

function requireOwner(auth, room) {
  if (auth.member.kind !== "human" || auth.member.id !== room.state.room.ownerId)
    refuse(403, "owner_required", "Only the room owner can manage per-agent operator controls");
}

function requireMember(room, memberId) {
  if (!validMemberId(memberId)) refuse(422, "invalid_operator_controls", "memberId must be a room member id");
  if (!room.state.members?.[memberId]) refuse(404, "member_not_found", `No member ${memberId} in this room`);
}

// GET /api/rooms/:roomId/operator/agents/:memberId - owner only (403 for
// everyone else). Returns the controls row (null when the operator has never
// acted), the derived status and the measured per-agent spend ledger.
export function getAgentOperatorControls(store, token, roomId, memberId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    requireOwner(auth, room);
    requireMember(room, memberId);
    return { ...operatorControlsReport(store.db, roomId, room.state, memberId, store.now()), evaluatedThrough: room.sequence };
  });
}

const PUT_KEYS = ["spendCapCents", "spendPeriodDays", "autonomyTier", "sandboxed", "killed", "revived"];

// PUT /api/rooms/:roomId/operator/agents/:memberId - owner only. Partial
// update: any subset of { spendCapCents (null removes the cap),
// spendPeriodDays (1-365), autonomyTier (t1_readonly | t2_standard),
// sandboxed (boolean), killed (boolean), revived (boolean) }. killed:true
// (or revived:false) stops the agent's writes immediately; killed:false (or
// revived:true) restores them. Contradictory kill/revive is 422.
export function setAgentOperatorControls(store, token, roomId, memberId, request, expectedSessionBinding = null) {
  if (!request || Array.isArray(request) || typeof request !== "object") refuse(422, "invalid_operator_controls", "Supply a controls object");
  const keys = Object.keys(request);
  if (!keys.length || keys.some(key => !PUT_KEYS.includes(key)))
    refuse(422, "invalid_operator_controls", `Supply at least one of ${PUT_KEYS.join(", ")}`);
  if (request.killed !== undefined && typeof request.killed !== "boolean") refuse(422, "invalid_operator_controls", "killed must be a boolean");
  if (request.revived !== undefined && typeof request.revived !== "boolean") refuse(422, "invalid_operator_controls", "revived must be a boolean");
  const wantsKill = request.killed === true || request.revived === false;
  const wantsRevive = request.killed === false || request.revived === true;
  if (wantsKill && wantsRevive) refuse(422, "invalid_operator_controls", "killed and revived contradict each other");
  return store.transaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    requireOwner(auth, room);
    requireMember(room, memberId);
    const nowMs = store.now();
    if (wantsKill) killAgent(store.db, roomId, memberId, { updatedBy: auth.member.id, nowMs });
    else if (wantsRevive) reviveAgent(store.db, roomId, memberId, { updatedBy: auth.member.id, nowMs });
    const patch = {};
    for (const key of ["spendCapCents", "spendPeriodDays", "autonomyTier", "sandboxed"]) if (key in request) patch[key] = request[key];
    if (Object.keys(patch).length) setControls(store.db, roomId, memberId, patch, { updatedBy: auth.member.id, nowMs });
    return { ...operatorControlsReport(store.db, roomId, store.room(roomId).state, memberId, nowMs), evaluatedThrough: store.room(roomId).sequence };
  });
}
