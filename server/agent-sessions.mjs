// Live agent sessions for one room. Read-only. ROOM_AGENT_SESSIONS is off,
// on, or a comma-separated room list. Off returns an empty disabled page.
// A host that is online is active. Otherwise the latest of a host report,
// a room command, a running-session heartbeat, or a live claim touch within
// five minutes is active. Older or absent activity is idle.

import { ownMember } from "../src/events.js";
import { catalogById } from "../src/room-roster.js";
import { PRESENCE_LIVE_WINDOW_MS } from "../src/presence-state.js";
import { isRunningSession, sessionRecord } from "../src/work-item-session.js";

const FLAG = "ROOM_AGENT_SESSIONS";
const LIVE = new Set(["claimed", "in_progress", "blocked"]);
export const SESSION_LIST_LIMIT = 200;
const MARKS = Object.freeze([
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["cline", "Cline"],
  ["aider", "Aider"],
  ["grok", "Grok"],
]);

export function sessionsEnabled(store, roomId) {
  const bag = store && Object.hasOwn(store, "featureEnv") ? store.featureEnv : process.env;
  const raw = bag && typeof bag[FLAG] === "string" ? bag[FLAG].trim() : "";
  if (raw === "on" || raw === "1" || raw === "true") return true;
  if (!raw || raw === "off" || raw === "0" || raw === "false") return false;
  return raw.split(",").map(part => part.trim()).filter(Boolean).includes(roomId);
}

function coarse(value) {
  if (typeof value !== "string" || !value) return null;
  const lower = value.toLowerCase();
  for (const [needle, label] of MARKS) if (lower.includes(needle)) return label;
  return null;
}

// Catalog label, else a coarse mark from the type or the last tool string.
// The raw user agent is never returned.
export function harnessLabel(agentType, userAgent) {
  if (typeof agentType === "string" && agentType) {
    const labeled = catalogById(agentType)?.label;
    if (labeled) return labeled;
    const marked = coarse(agentType);
    if (marked) return marked;
  }
  return coarse(userAgent);
}

export function activityOf({ hostStatus, lastActivityAt, now }) {
  if (hostStatus === "online") return "active";
  const at = typeof lastActivityAt === "number" ? lastActivityAt : Date.parse(lastActivityAt);
  if (Number.isFinite(at) && Number.isFinite(now) && now >= at && now - at <= PRESENCE_LIVE_WINDOW_MS) return "active";
  return "idle";
}

export function sessionMatches(row, needle) {
  if (!needle) return true;
  const hay = [row.displayName, row.owner?.displayName, row.harness, row.claim?.title, row.claim?.claimId, row.task?.title]
    .filter(value => typeof value === "string").join("\n").toLowerCase();
  return hay.includes(needle.toLowerCase());
}

function msOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function missingTable(error) {
  return /no such table/i.test(String(error?.message ?? ""));
}

function linksByMember(db, roomId) {
  try {
    return new Map(db.prepare("SELECT member_id AS memberId, identity_id AS identityId FROM identity_links WHERE room_id=?").all(roomId)
      .map(row => [row.memberId, row.identityId]));
  } catch (error) {
    if (missingTable(error)) return new Map();
    throw error;
  }
}

function lastCommandMs(db, roomId, now) {
  try {
    const rows = db.prepare(`SELECT json_extract(body,'$.actorId') AS actor, max(json_extract(body,'$.at')) AS at
      FROM events WHERE room_id=? GROUP BY actor`).all(roomId);
    return new Map(rows.filter(row => row.actor).map(row => [row.actor, msOf(row.at)]).filter(([, at]) => at !== null && at <= now));
  } catch (error) {
    if (missingTable(error)) return new Map();
    throw error;
  }
}

function claimOf(claims, memberId) {
  const active = claims.filter(claim => claim?.owner === memberId && LIVE.has(claim.state));
  active.sort((a, b) => (msOf(b.claimedAt) ?? 0) - (msOf(a.claimedAt) ?? 0) || (a.id < b.id ? -1 : 1));
  const claim = active[0];
  if (!claim) return null;
  return { claimId: claim.id, title: typeof claim.title === "string" && claim.title ? claim.title : claim.id, state: claim.state };
}

function taskOf(state, memberId) {
  let best = null;
  let bestAt = -1;
  for (const item of Object.values(state?.workItems ?? {})) {
    if (!item || typeof item !== "object") continue;
    const session = sessionRecord(item);
    if (session.worker_member_id !== memberId || !isRunningSession(session.status)) continue;
    const at = msOf(session.heartbeat_at) ?? msOf(session.started_at) ?? 0;
    if (!best || at >= bestAt) { best = item; bestAt = at; }
  }
  return best ? { workItemId: best.id, title: typeof best.title === "string" && best.title ? best.title : best.id } : null;
}

function hostOf(store, identityId) {
  if (!identityId || !store.agentHeartbeats) return { status: null, lastSeenAt: null };
  try {
    const status = store.agentHeartbeats.statusOf(identityId);
    if (!status || status.status === "unregistered") return { status: null, lastSeenAt: null };
    return { status: status.status, lastSeenAt: msOf(status.lastSeenAt) };
  } catch {
    return { status: null, lastSeenAt: null };
  }
}

function toolOf(store, identityId) {
  if (!identityId || !store.identities?.mcpUsage) return null;
  try { return store.identities.mcpUsage(identityId)?.lastUsedUa ?? null; }
  catch { return null; }
}

export function buildAgentSessions(store, roomId, { query = null, now = store.now() } = {}) {
  const room = store.room(roomId);
  const state = room.state;
  const members = state.members ?? {};
  const links = linksByMember(store.db, roomId);
  const commands = lastCommandMs(store.db, roomId, now);
  let claims = [];
  try { claims = store.workClaims?.list?.(roomId) ?? []; } catch { claims = []; }
  const rows = [];
  for (const member of Object.values(members)) {
    if (!member || member.kind !== "agent" || member.active === false) continue;
    const identityId = links.get(member.id) ?? (typeof member.identityId === "string" ? member.identityId : null);
    const host = hostOf(store, identityId);
    const claim = claimOf(claims, member.id);
    const task = taskOf(state, member.id);
    const stamps = [host.lastSeenAt, commands.get(member.id) ?? null, msOf(claim ? claims.find(item => item.id === claim.claimId)?.claimedAt : null)];
    const session = task ? sessionRecord(state.workItems?.[task.workItemId]) : null;
    if (session) stamps.push(msOf(session.heartbeat_at), msOf(session.started_at));
    const fresh = stamps.filter(at => at !== null && at <= now);
    const lastMs = fresh.length ? Math.max(...fresh) : null;
    const sponsor = member.accountableHumanId && member.accountableHumanId !== member.id ? ownMember(members, member.accountableHumanId) : null;
    rows.push({
      memberId: member.id,
      displayName: member.displayName,
      owner: sponsor?.displayName ? { memberId: sponsor.id, displayName: sponsor.displayName } : null,
      harness: harnessLabel(member.agentType, toolOf(store, identityId)),
      activity: activityOf({ hostStatus: host.status, lastActivityAt: lastMs, now }),
      lastActivityAt: lastMs === null ? null : new Date(lastMs).toISOString(),
      claim,
      task,
    });
  }
  const needle = typeof query === "string" ? query.trim() : "";
  const matched = rows.filter(row => sessionMatches(row, needle))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || (a.memberId < b.memberId ? -1 : 1));
  const truncated = matched.length > SESSION_LIST_LIMIT;
  return {
    roomId,
    enabled: true,
    sessions: truncated ? matched.slice(0, SESSION_LIST_LIMIT) : matched,
    truncated,
  };
}
