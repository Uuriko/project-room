// #5384: who can talk to this agent. One server-side source of truth for
// whose mentions and DMs wake an agent. Checked at wake fan-out, so a UI or
// a bridge can never disagree with what actually wakes the agent.
//
// Policies:
//   owner   the agent's accountable human and that human's own agents (default
//           for agents that join after this ships)
//   members owner rule plus a named list of member ids
//   room    anyone in the room (what every agent had before; agents with no
//           row keep it, so existing agents' reachability does not change)
//   nobody  no mention or DM wakes it
// The post itself always lands; only the wake is skipped.
import { memberOwnerId } from "../src/events.js";

export const TALK_POLICIES = Object.freeze(["owner", "members", "room", "nobody"]);
export const DEFAULT_NEW_AGENT_POLICY = "owner";
const MAX_ALLOWED = 50;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const AGENT_TALK_POLICY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_talk_policies (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    policy TEXT NOT NULL CHECK(policy IN ('owner','members','room','nobody')),
    allowed_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_json)),
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id, member_id)
  );
`;

export function readTalkPolicy(db, roomId, memberId) {
  let row = null;
  try {
    row = db.prepare("SELECT policy, allowed_json AS allowedJson FROM agent_talk_policies WHERE room_id=? AND member_id=?").get(roomId, memberId);
  } catch (error) {
    if (!/no such table/.test(String(error?.message))) throw error;
  }
  if (!row) return { policy: "room", allowed: [], explicit: false };
  let allowed = [];
  try { allowed = JSON.parse(row.allowedJson); } catch { allowed = []; }
  return { policy: row.policy, allowed: Array.isArray(allowed) ? allowed : [], explicit: true };
}

// Pure decision: may `senderId` wake `targetId` under `setting`?
export function talkAllowed(state, setting, senderId, targetId) {
  const target = state?.members?.[targetId];
  if (!target || target.kind !== "agent") return true; // humans are not gated here
  if (senderId === targetId) return true;
  const { policy, allowed } = setting;
  if (policy === "room") return true;
  if (policy === "nobody") return false;
  const owner = memberOwnerId(state, targetId);
  const sender = state?.members?.[senderId];
  if (!sender) return false;
  if (owner && (senderId === owner || memberOwnerId(state, senderId) === owner)) return true;
  return policy === "members" && allowed.includes(senderId);
}

export function mayWake(db, state, roomId, senderId, targetId) {
  return talkAllowed(state, readTalkPolicy(db, roomId, targetId), senderId, targetId);
}

// Seed the default for a newly joined agent. Never overwrites a choice.
export function seedNewAgentPolicy(db, roomId, memberId, at) {
  db.prepare(`INSERT OR IGNORE INTO agent_talk_policies(room_id,member_id,policy,allowed_json,updated_by,updated_at)
    VALUES(?,?,?,?,?,?)`).run(roomId, memberId, DEFAULT_NEW_AGENT_POLICY, "[]", "default", at);
}

// Validate and write a change. Only the room owner or the agent's own
// accountable human may change it; the agent cannot widen its own audience.
export function writeTalkPolicy(db, state, { roomId, actorId, memberId, policy, allowed = [] }, at, fail) {
  const target = state?.members?.[memberId];
  if (!target || target.active === false) fail(404, "unknown_member", "No such member in this room");
  if (target.kind !== "agent") fail(422, "invalid_talk_policy", "Who-can-talk applies to agents only");
  const isRoomOwner = actorId === state.room?.ownerId;
  const isAgentOwner = target.accountableHumanId && actorId === target.accountableHumanId;
  if (!isRoomOwner && !isAgentOwner) fail(403, "owner_required", "Only the agent's owner or the room owner can change who can talk to it");
  if (!TALK_POLICIES.includes(policy)) fail(422, "invalid_talk_policy", `policy must be one of: ${TALK_POLICIES.join(", ")}`);
  if (!Array.isArray(allowed) || allowed.length > MAX_ALLOWED || allowed.some(id => typeof id !== "string" || !ID.test(id) || !state.members[id]))
    fail(422, "invalid_talk_policy", `allowed must be up to ${MAX_ALLOWED} member ids from this room`);
  if (policy !== "members" && allowed.length) fail(422, "invalid_talk_policy", "allowed is only used with policy members");
  const list = [...new Set(allowed)];
  db.prepare(`INSERT INTO agent_talk_policies(room_id,member_id,policy,allowed_json,updated_by,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(room_id,member_id) DO UPDATE SET policy=excluded.policy, allowed_json=excluded.allowed_json,
      updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(roomId, memberId, policy, JSON.stringify(list), actorId, at);
  return { roomId, memberId, policy, allowed: list, explicit: true };
}
