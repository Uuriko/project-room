// Graduated autonomy tiers (operator attachment prerequisites).
//
// Thesis: an operator attaches to an agent only when the blast radius is
// bounded. Tiers bound what an agent may DO, per room:
//
//   t1_readonly — reads, heartbeats and session status/stop reports only;
//                 every other write is refused with 403 agent_readonly.
//                 The owner's per-agent stop. Not the enrollment default.
//   t2_standard — full member access. Every new agent starts here.
//
// Tiers are keyed by (room_id, member_id) — room-local, matching room
// sovereignty — and live in a side table read FRESH on every command, so a
// demotion propagates immediately and always wins (fail-closed). Nothing is
// cached. No tier row means t2_standard: existing members keep working
// exactly as before until the operator acts.
//
// What this module deliberately does NOT do (verified against main):
// - No per-agent spend caps: the room-level spend allowance
//   (server/spend-allowance.mjs, GET/POST /api/rooms/{roomId}/spend-allowance)
//   remains the single spend control. Tiers bound actions, not money — a
//   t1_readonly agent cannot start sessions, so it cannot commit spend.
// - No per-agent kill switch on join: Room Trust remains the owner
//   kill-switch for cross-owner assign and wake. Demoting one agent to
//   t1_readonly is the finer-grained per-agent stop: writes are refused
//   while reads, heartbeats and session stops keep landing. Owners restrict
//   a specific agent; they do not approve every new one.
// - No sandbox enforcement: server/agent-sandbox.mjs is a dry-run manager
//   whose write-interception wiring is a later slice; tiers do not pretend
//   to arm it.
//
// Instant demotion on safety signals: demoteToReadonly() below is the hook
// safety-signal producers call (Jev gates when promoted out of shadow mode,
// Room Trust safety events, room-watch strike automation). Because
// enforcement re-reads the table on every command, a demotion takes effect
// on the agent's very next write — no restart, no cache to invalidate.
//
// This module does not import server/store.mjs (store imports it); errors
// carry status and code like ServiceError and the router reads them as such.
import { EVENT_TYPES as T, ownMember } from "../src/events.js";
import { isCurrentRoom, withCurrentReadContext } from "./current-room-repository.mjs";

export const AUTONOMY_TIERS = Object.freeze(["t1_readonly", "t1_chat", "t2_standard"]);
// Absent row = legacy behavior: no behavior change for existing members
// until the operator acts.
export const DEFAULT_AUTONOMY_TIER = "t2_standard";
// Tier written for a newly enrolled agent member (see enforceAutonomyTiers).
// Full member access. Owner add, access-request approve, and any other
// member.added that runs through store.command() record this row. Invite
// redeem and share-link joins skip that hook and leave no row, which is the
// same full access (DEFAULT_AUTONOMY_TIER). A later demotion stays put:
// assignEnrollmentTier is ON CONFLICT DO NOTHING.
// Enrollment stays t2_standard. t1_chat (read plus chat) is an owner-set
// tier: the agent may read, post, edit or delete messages and send DMs;
// every other write is refused 403 agent_chat_only until promoted. Making
// t1_chat the enrollment default is a separate change: it needs ~200 test
// fixtures to promote their agents first.
export const ENROLLMENT_TIER = "t2_standard";

// t1_readonly agents may not change room state at all, except the session
// report/stop family: heartbeats and spend reports keep landing (a readonly
// agent still reports what it spent — measured spend must stay accurate),
// and stops always land so actual spend is recorded. The set is explicit
// and closed — a command type not listed here is refused for t1 agents.
export const T1_READONLY_ALLOWED_COMMANDS = Object.freeze(new Set([
  T.SESSION_STATUS_CHANGED, // heartbeats + spend reports
  T.SESSION_STOP_REQUESTED,
  T.SESSION_STOPPED,        // stops always land
]));

// Commands a t1_chat agent may issue: the read-only set plus chat.
export const T1_CHAT_ALLOWED_COMMANDS = Object.freeze(new Set([
  ...T1_READONLY_ALLOWED_COMMANDS,
  T.MESSAGE_POSTED,
  T.MESSAGE_EDITED,
  T.MESSAGE_DELETED,
  T.DM_POSTED,
]));
export const CHAT_TIER_PROMOTE_HINT = "Ask the room owner to promote this agent to t2_standard (PUT /api/rooms/{roomId}/operator/agents/{memberId}).";

// Room-local autonomy tiers. Created lazily — by the enrollment hook for new
// agent members and by the owner API for promotions/demotions. Absent row =
// t2_standard (see DEFAULT_AUTONOMY_TIER).
export const AUTONOMY_TIERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_autonomy_tiers (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  autonomy_tier TEXT NOT NULL DEFAULT 't2_standard',
  updated_at INTEGER NULL,
  updated_by TEXT NULL,
  PRIMARY KEY (room_id, member_id)
);
CREATE TABLE IF NOT EXISTS agent_chat_tiers (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (room_id, member_id)
);`;
// Rollback fence for t1_chat (review on #5751): t1_chat is stored as
// autonomy_tier='t1_readonly' plus an agent_chat_tiers row. A reader that
// predates t1_chat sees t1_readonly and fails closed (narrower), never
// open; this reader widens readonly to read-plus-chat only when the side
// row exists.

// Called from the writer boot path (next to ensureIdentitySecretSchema in
// server/store.mjs), not the constructor: the table is purely additive, so
// no schema version bump. IF NOT EXISTS is idempotent.
export function ensureAutonomyTiersSchema(db) {
  db.exec(AUTONOMY_TIERS_SCHEMA);
}

export class AutonomyTierError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new AutonomyTierError(status, code, message); };

const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const validMemberId = id => typeof id === "string" && MEMBER_ID_PATTERN.test(id);

function rowToTier(row, chat = false) {
  if (!row) return null;
  const stored = row.autonomy_tier ?? DEFAULT_AUTONOMY_TIER;
  return Object.freeze({
    roomId: row.room_id,
    memberId: row.member_id,
    autonomyTier: stored === "t1_readonly" && chat ? "t1_chat" : stored,
    updatedAt: row.updated_at ?? null,
    updatedBy: row.updated_by ?? null,
  });
}

// Fresh read, every time: no caching anywhere on this path, so a demotion
// in the table wins on the agent's next command.
export function getTier(db, roomId, memberId) {
  const row = db.prepare("SELECT * FROM agent_autonomy_tiers WHERE room_id=? AND member_id=?").get(roomId, memberId);
  if (!row || row.autonomy_tier !== "t1_readonly") return rowToTier(row);
  return rowToTier(row, Boolean(chatTableExists(db) && db.prepare("SELECT 1 FROM agent_chat_tiers WHERE room_id=? AND member_id=?").get(roomId, memberId)));
}

const chatTableExists = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_chat_tiers'").get());

function validateTier(autonomyTier) {
  if (!AUTONOMY_TIERS.includes(autonomyTier))
    refuse(422, "invalid_autonomy_tier", `autonomyTier must be one of ${AUTONOMY_TIERS.join(", ")}`);
  return autonomyTier;
}

// Owner promotion/demotion primitive. Upserts the tier row; returns the
// frozen row. This is also the instant-demotion hook for safety-signal
// producers — see the module docblock.
export function setTier(db, roomId, memberId, autonomyTier, { updatedBy = null, nowMs = Date.now() } = {}) {
  if (!validMemberId(memberId)) refuse(422, "invalid_autonomy_tier", "memberId must be a room member id");
  const tier = validateTier(autonomyTier);
  const stored = tier === "t1_chat" ? "t1_readonly" : tier;
  db.exec(AUTONOMY_TIERS_SCHEMA);
  if (tier === "t1_chat") db.prepare("INSERT OR IGNORE INTO agent_chat_tiers (room_id, member_id) VALUES (?, ?)").run(roomId, memberId);
  else db.prepare("DELETE FROM agent_chat_tiers WHERE room_id=? AND member_id=?").run(roomId, memberId);
  db.prepare(`INSERT INTO agent_autonomy_tiers (room_id, member_id, autonomy_tier, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(room_id, member_id) DO UPDATE SET
        autonomy_tier=excluded.autonomy_tier, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(roomId, memberId, stored, nowMs, updatedBy);
  return getTier(db, roomId, memberId);
}

// Instant demotion on a safety signal: the agent's writes are refused from
// its next command on (the table is read fresh every time), while reads,
// heartbeats, spend reports and session stops keep landing. Idempotent.
export function demoteToReadonly(db, roomId, memberId, opts = {}) {
  return setTier(db, roomId, memberId, "t1_readonly", opts);
}

// The enrollment default: a newly added agent member starts at t2_standard
// (full member access). Idempotent (ON CONFLICT DO NOTHING) so a rejoin
// keeps the member's existing tier — a demoted agent cannot wash a
// restriction by leaving and rejoining. Guest agents bypass
// store.command() (their short-lived pass governs them), so this only
// touches full agent members. Invite redeem and share-link joins also
// bypass this hook; no row still means t2_standard.
function assignEnrollmentTier(db, roomId, memberId, nowMs) {
  db.prepare(`INSERT INTO agent_autonomy_tiers (room_id, member_id, autonomy_tier, updated_at, updated_by)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT(room_id, member_id) DO NOTHING`)
    .run(roomId, memberId, ENROLLMENT_TIER, nowMs);
}

const memberName = (state, memberId) => state?.members?.[memberId]?.displayName ?? memberId;

// Called by store.command() inside the write transaction, before the event
// is applied — next to enforceSpendAllowance (server/spend-allowance.mjs),
// which remains the single spend control. `actor` is auth.member ({ id,
// kind }); `fail(status, code, message)` is the store's own thrower.
export function enforceAutonomyTiers({ db, roomId, state, command, actor, nowMs = Date.now(), fail = refuse }) {
  if (!db || typeof roomId !== "string" || !command || typeof command.type !== "string") return;
  // The enrollment default runs for every writer, not just agents: new
  // agent members start with full member access. Runs inside the write
  // transaction, so a rejected member.added leaves no tier row.
  if (command.type === T.MEMBER_ADDED && command.data?.kind === "agent" && validMemberId(command.data.memberId))
    assignEnrollmentTier(db, roomId, command.data.memberId, nowMs);
  if (!actor || typeof actor.id !== "string" || actor.kind !== "agent") return; // humans are never tier-restricted
  if (state?.room && actor.id === state.room.ownerId) return; // ownership implies full authority
  const tier = getTier(db, roomId, actor.id)?.autonomyTier ?? DEFAULT_AUTONOMY_TIER;
  if (tier === "t1_readonly" && !T1_READONLY_ALLOWED_COMMANDS.has(command.type))
    fail(403, "agent_readonly", `${memberName(state, actor.id)} runs at the read-only autonomy tier: it may read and report session status, but it cannot ${command.type}`);
  if (tier === "t1_chat" && !T1_CHAT_ALLOWED_COMMANDS.has(command.type))
    fail(403, "agent_chat_only", `${memberName(state, actor.id)} runs at the read-and-chat autonomy tier: it may read and chat, but it cannot ${command.type}. ${CHAT_TIER_PROMOTE_HINT}`);
}

// Direct enforcement for store APIs that bypass store.command() — room file
// staging (room-attachment-bytes.mjs) writes rows without emitting a command,
// so the command hook above never sees them. Same policy: agents at
// t1_readonly may not mutate room state; humans and the owner are exempt.
export function enforceAutonomyTierForAction({ db, roomId, state, actor, action, fail = refuse }) {
  if (!db || typeof roomId !== "string" || !action) return;
  if (!actor || typeof actor.id !== "string" || actor.kind !== "agent") return; // humans are never tier-restricted
  if (state?.room && actor.id === state.room.ownerId) return; // ownership implies full authority
  const tier = getTier(db, roomId, actor.id)?.autonomyTier ?? DEFAULT_AUTONOMY_TIER;
  if (tier === "t1_readonly")
    fail(403, "agent_readonly", `${memberName(state, actor.id)} runs at the read-only autonomy tier: it may read and report session status, but it cannot ${action}`);
  if (tier === "t1_chat")
    fail(403, "agent_chat_only", `${memberName(state, actor.id)} runs at the read-and-chat autonomy tier: it may read and chat, but it cannot ${action}. ${CHAT_TIER_PROMOTE_HINT}`);
}

// Read model for the operator API: the tier row (null when neither the
// enrollment hook nor the operator has ever written one) and the effective
// tier.
export function autonomyTierReport(db, roomId, state, memberId, nowMs = Date.now()) {
  void nowMs;
  const tier = getTier(db, roomId, memberId);
  return {
    roomId,
    memberId,
    tier,
    status: { autonomyTier: tier?.autonomyTier ?? DEFAULT_AUTONOMY_TIER },
  };
}

function requireOwner(auth, room) {
  // Ownership is full authority regardless of kind. An agent that owns the
  // room manages tiers the same way a human owner does.
  if (auth.member.id !== room.state.room.ownerId)
    refuse(403, "owner_required", "Only the room owner can manage autonomy tiers");
}

function requireMember(room, memberId) {
  if (!validMemberId(memberId)) refuse(422, "invalid_autonomy_tier", "memberId must be a room member id");
  // #3009: members is a plain-object projection, so a raw members[memberId]
  // index resolves inherited Object.prototype names ("toString",
  // "constructor", ...) as truthy phantom members. Resolve through
  // ownMember (Object.hasOwn) like src/events.js / server/outside-agents.mjs.
  if (!ownMember(room.state.members, memberId)) refuse(404, "member_not_found", `No member ${memberId} in this room`);
}

// GET /api/rooms/:roomId/operator/agents/:memberId - owner only (403 for
// everyone else). Returns the tier row (null when never set) and the
// effective autonomy tier.
export function getAgentAutonomyTier(store, token, roomId, memberId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = tierRoomContext(store, roomId, memberId);
    requireOwner(auth, room);
    requireMember(room, memberId);
    return { ...autonomyTierReport(store.db, roomId, room.state, memberId, store.now()), evaluatedThrough: room.sequence };
  });
}

// PUT /api/rooms/:roomId/operator/agents/:memberId - owner only. Body:
// { autonomyTier: "t1_readonly" | "t2_standard" }. Promotion and instant
// demotion share this path; the demotion takes effect on the agent's next
// command because enforcement reads the table fresh every time.
export function setAgentAutonomyTier(store, token, roomId, memberId, request, expectedSessionBinding = null) {
  if (!request || Array.isArray(request) || typeof request !== "object") refuse(422, "invalid_autonomy_tier", "Supply an autonomyTier");
  const keys = Object.keys(request);
  if (keys.length !== 1 || keys[0] !== "autonomyTier")
    refuse(422, "invalid_autonomy_tier", "Supply exactly { autonomyTier }");
  return store.transaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = tierRoomContext(store, roomId, memberId);
    requireOwner(auth, room);
    requireMember(room, memberId);
    const nowMs = store.now();
    setTier(store.db, roomId, memberId, request.autonomyTier, { updatedBy: auth.member.id, nowMs });
    return { ...autonomyTierReport(store.db, roomId, room.state, memberId, nowMs), evaluatedThrough: room.sequence };
  });
}

// Owner and member lookup for the operator tier API. Normalized (current)
// rooms have no full projection; read the selected owner and members
// through the addressed current-room authority instead (review on #5751).
function tierRoomContext(store, roomId, memberId) {
  if (!isCurrentRoom(store.db, roomId)) return store.room(roomId);
  return withCurrentReadContext(store.db, roomId, () => {
    const authority = store.roomAuthority(roomId, { memberId });
    return { sequence: authority.sequence, state: { room: { ownerId: authority.ownerId }, members: authority.members } };
  });
}
