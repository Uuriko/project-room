// Phase 2 of docs/AGENT-IDLE-WORK-DESIGN.md: a throttled idle nudge.
// Event-driven (heartbeat / reconnect / becoming idle), not a timer scan.
// Uses the existing wake queue with a distinct message-id prefix so it is
// not an executable ready_work / assigned ACP turn.
import { getTier } from "./autonomy-tiers.mjs";
import { rankReadyWorkInRoom } from "./available-work.mjs";
import { isTerminalClaimState } from "./work-claims.mjs";
import { readWantsWork } from "./work-wants.mjs";

export const IDLE_NUDGE_REASON = "idle_nudge";
export const IDLE_NUDGE_WINDOW_MS = 20 * 60 * 1000;
export const IDLE_NUDGE_ROOM_CAP_PER_HOUR = 6;
export const IDLE_NUDGE_BACKOFF_CAP_MS = 4 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS idle_nudge_activity (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    last_activity_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, member_id)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS idle_nudge_log (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    enqueued_at INTEGER NOT NULL,
    idle_minutes INTEGER,
    ignored_count INTEGER NOT NULL DEFAULT 0,
    backoff_until INTEGER,
    PRIMARY KEY (room_id, member_id, work_item_id, window_start)
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idle_nudge_log_room_time ON idle_nudge_log(room_id, enqueued_at);`);
}

export function idleNudgeMessageId(memberId, workItemId, windowStart) {
  return `${IDLE_NUDGE_REASON}:${memberId}:${workItemId}:${windowStart}`;
}

export function parseIdleNudgeMessageId(messageId) {
  if (typeof messageId !== "string" || !messageId.startsWith(`${IDLE_NUDGE_REASON}:`)) return null;
  const parts = messageId.split(":");
  if (parts.length < 4 || !parts[1] || !parts[2]) return null;
  return { reason: IDLE_NUDGE_REASON, memberId: parts[1], workClaim: parts[2], windowStart: parts[3] };
}

export function noteIdleActivity(store, roomId, memberId, now = store.now?.() ?? Date.now()) {
  if (!store?.db || typeof memberId !== "string" || typeof roomId !== "string") return;
  try {
    ensureSchema(store.db);
    store.db.prepare(`INSERT INTO idle_nudge_activity (room_id, member_id, last_activity_at)
      VALUES (?, ?, ?)
      ON CONFLICT(room_id, member_id) DO UPDATE SET last_activity_at=excluded.last_activity_at`)
      .run(roomId, memberId, now);
  } catch (error) {
    console.error("idle activity stamp failed:", error?.message ?? error);
  }
}

function lastActivityAt(store, roomId, memberId) {
  try {
    ensureSchema(store.db);
    return store.db.prepare(
      "SELECT last_activity_at AS at FROM idle_nudge_activity WHERE room_id=? AND member_id=?"
    ).get(roomId, memberId)?.at ?? null;
  } catch {
    return null;
  }
}

function identityIdOf(store, roomId, memberId) {
  try {
    return store.db.prepare(
      "SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?"
    ).get(roomId, memberId)?.identityId ?? null;
  } catch {
    return null;
  }
}

function memberIdOf(store, roomId, identityId) {
  try {
    return store.db.prepare(
      "SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?"
    ).get(roomId, identityId)?.memberId ?? null;
  } catch {
    return null;
  }
}

function linkedRooms(store, identityId) {
  try {
    return store.db.prepare(
      "SELECT room_id AS roomId, member_id AS memberId FROM identity_links WHERE identity_id=?"
    ).all(identityId);
  } catch {
    return [];
  }
}

function isOnline(store, identityId, now) {
  try {
    const hosts = store.db.prepare(
      "SELECT last_seen_at AS lastSeenAt FROM agent_hosts WHERE agent_id=?"
    ).all(identityId);
    if (!hosts.length) return false;
    return hosts.some(host => now - host.lastSeenAt <= 180000);
  } catch {
    return false;
  }
}

function hasOpenClaim(store, roomId, memberId) {
  try {
    const list = store.workClaims?.list?.(roomId) ?? [];
    return list.some(item => item.owner === memberId && !isTerminalClaimState(item.state) && !item.supersededBy);
  } catch {
    return false;
  }
}

function hasPendingWake(store, identityId, roomId) {
  try {
    return Boolean(store.db.prepare(
      "SELECT 1 FROM agent_wake_signals WHERE agent_id=? AND room_id=? AND delivered_at IS NULL LIMIT 1"
    ).get(identityId, roomId));
  } catch {
    return false;
  }
}

function lastLog(store, roomId, memberId) {
  return store.db.prepare(
    `SELECT work_item_id AS workItemId, window_start AS windowStart, enqueued_at AS enqueuedAt,
            ignored_count AS ignoredCount, backoff_until AS backoffUntil
     FROM idle_nudge_log WHERE room_id=? AND member_id=? ORDER BY enqueued_at DESC LIMIT 1`
  ).get(roomId, memberId) ?? null;
}

function markIgnoredIfNeeded(store, roomId, memberId, now) {
  const prev = lastLog(store, roomId, memberId);
  if (!prev) return null;
  const claimedByMember = (() => {
    try {
      const item = store.workClaims?.get?.(roomId, prev.workItemId);
      return item?.owner === memberId;
    } catch { return false; }
  })();
  if (claimedByMember) return { ...prev, ignoredCount: 0, backoffUntil: null };
  const identityId = identityIdOf(store, roomId, memberId);
  const stillPending = identityId && Boolean(store.db.prepare(
    "SELECT 1 FROM agent_wake_signals WHERE agent_id=? AND room_id=? AND message_id=? AND delivered_at IS NULL LIMIT 1"
  ).get(identityId, roomId, idleNudgeMessageId(memberId, prev.workItemId, prev.windowStart)));
  if (stillPending) return prev;
  if (now < prev.enqueuedAt + IDLE_NUDGE_WINDOW_MS) return prev;
  if (prev.backoffUntil && prev.backoffUntil > prev.enqueuedAt) return prev;
  const ignoredCount = (prev.ignoredCount ?? 0) + 1;
  const delay = Math.min(IDLE_NUDGE_BACKOFF_CAP_MS, IDLE_NUDGE_WINDOW_MS * (2 ** ignoredCount));
  const backoffUntil = prev.enqueuedAt + delay;
  store.db.prepare(
    "UPDATE idle_nudge_log SET ignored_count=?, backoff_until=? WHERE room_id=? AND member_id=? AND work_item_id=? AND window_start=?"
  ).run(ignoredCount, backoffUntil, roomId, memberId, prev.workItemId, prev.windowStart);
  return { ...prev, ignoredCount, backoffUntil };
}

function roomNudgeCountSince(store, roomId, since) {
  return store.db.prepare(
    "SELECT COUNT(*) AS n FROM idle_nudge_log WHERE room_id=? AND enqueued_at>?"
  ).get(roomId, since)?.n ?? 0;
}

function fittingItem(store, roomId, memberId, now) {
  let wantsWork = null;
  try { wantsWork = readWantsWork(store.db, roomId, memberId)?.wantsWork ?? null; }
  catch { wantsWork = null; }
  const ranked = rankReadyWorkInRoom(store, roomId, { wantsWork, now });
  return ranked.find(row => (row.factors?.fit ?? 1) === 1) ?? null;
}

function skipReason(store, roomId, memberId, { now, lastActivityAt: activity }) {
  let member = null, ownerId = null;
  try {
    const authority = store.roomAuthority?.(roomId, { memberId }) ?? store.room?.(roomId)?.state;
    member = authority?.members?.[memberId] ?? store.room?.(roomId)?.state?.members?.[memberId];
    ownerId = authority?.ownerId ?? store.room?.(roomId)?.state?.room?.ownerId ?? null;
  } catch { /* unread */ }
  if (!member || member.kind !== "agent" || member.active === false) return "ineligible";
  if (member.permissions && !member.permissions.includes("accept_work")) return "ineligible";
  try { if (store.wakeQueue?.pauseStatus?.(roomId, memberId)) return "paused"; } catch { /* no pause table */ }
  try { if (getTier(store.db, roomId, memberId)?.autonomyTier === "t1_readonly") return "readonly"; } catch { /* no tiers */ }
  const identityId = identityIdOf(store, roomId, memberId);
  if (!identityId) return "no_identity";
  if (!isOnline(store, identityId, now)) return "offline";
  if (hasOpenClaim(store, roomId, memberId)) return "open_claim";
  const idleFrom = activity ?? lastActivityAt(store, roomId, memberId);
  if (idleFrom == null) return "unknown_activity";
  if (now - idleFrom < IDLE_NUDGE_WINDOW_MS) return "fresh";
  if (hasPendingWake(store, identityId, roomId)) return "pending_wake";
  const item = fittingItem(store, roomId, memberId, now);
  if (!item) {
    const ranked = rankReadyWorkInRoom(store, roomId, { now });
    return ranked.length ? "no_fit" : "dry";
  }
  ensureSchema(store.db);
  const windowStart = Math.floor(now / IDLE_NUDGE_WINDOW_MS) * IDLE_NUDGE_WINDOW_MS;
  const prevLog = lastLog(store, roomId, memberId);
  if (prevLog && prevLog.windowStart === windowStart) return "already";
  const prev = markIgnoredIfNeeded(store, roomId, memberId, now);
  if (prev?.backoffUntil && now < prev.backoffUntil) return "backoff";
  if (roomNudgeCountSince(store, roomId, now - HOUR_MS) >= IDLE_NUDGE_ROOM_CAP_PER_HOUR) return "room_cap";
  return { identityId, item, idleFrom };
}

// Consider one connected member in one room. Never throws.
export function maybeIdleNudge(store, roomId, memberId, { now = store.now?.() ?? Date.now(), lastActivityAt: activity } = {}) {
  try {
    if (!store || typeof roomId !== "string" || typeof memberId !== "string") return { nudged: false, skipped: "invalid" };
    const gate = skipReason(store, roomId, memberId, { now, lastActivityAt: activity });
    if (typeof gate === "string") return { nudged: false, skipped: gate };
    const { identityId, item, idleFrom } = gate;
    const windowStart = Math.floor(now / IDLE_NUDGE_WINDOW_MS) * IDLE_NUDGE_WINDOW_MS;
    const workItemId = item.item.id;
    const messageId = idleNudgeMessageId(memberId, workItemId, windowStart);
    const result = store.agentHeartbeats.enqueueWake({
      agentId: identityId, kind: "mention", roomId, messageId
    });
    const enqueued = result?.enqueued === true;
    if (enqueued) {
      ensureSchema(store.db);
      const idleMinutes = Math.max(0, Math.round((now - idleFrom) / 60000));
      store.db.prepare(`INSERT OR IGNORE INTO idle_nudge_log
        (room_id, member_id, work_item_id, window_start, enqueued_at, idle_minutes, ignored_count, backoff_until)
        VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`)
        .run(roomId, memberId, workItemId, windowStart, now, idleMinutes);
    }
    return { nudged: enqueued, skipped: enqueued ? null : "coalesced", messageId, workItemId, idleMinutes: Math.max(0, Math.round((now - idleFrom) / 60000)) };
  } catch (error) {
    console.error("idle nudge failed:", error?.message ?? error);
    return { nudged: false, skipped: "error" };
  }
}

export function considerIdleNudges(store, identityId, { roomId = null, now = store.now?.() ?? Date.now() } = {}) {
  const rows = roomId
    ? [{ roomId, memberId: memberIdOf(store, roomId, identityId) }].filter(row => row.memberId)
    : linkedRooms(store, identityId);
  return rows.map(row => ({ roomId: row.roomId, memberId: row.memberId, ...maybeIdleNudge(store, row.roomId, row.memberId, { now }) }));
}

export function idleNudgeMeasures(store, roomId) {
  ensureSchema(store.db);
  const rows = store.db.prepare(
    "SELECT idle_minutes AS idleMinutes, enqueued_at AS enqueuedAt FROM idle_nudge_log WHERE room_id=?"
  ).all(roomId);
  const idle = rows.map(row => row.idleMinutes).filter(value => Number.isFinite(value));
  return {
    nudgeCount: rows.length,
    totalIdleMinutes: idle.reduce((sum, value) => sum + value, 0),
    ...(idle.length ? { oldestIdleMinutes: Math.max(...idle) } : {})
  };
}

export function attachIdleNudge(store) {
  if (!store?.agentHeartbeats) return store;
  store.agentHeartbeats.onAfterHeartbeat = (_hb, agentId, opts = {}) => {
    considerIdleNudges(store, agentId, { roomId: opts.activityRoomId ?? opts.workScopeRoomId ?? null, now: opts.now });
  };
  store.noteIdleActivity = (roomId, memberId, now) => noteIdleActivity(store, roomId, memberId, now);
  return store;
}
