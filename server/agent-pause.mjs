import { isCurrentRoom } from "./current-room-repository.mjs";
import { ServiceError } from "./service-error.mjs";
import { ACK_WINDOW_MS, STALE_AFTER_MS } from "./request-states.mjs";

const REPEATED_MISS_HOLD_MS = 2 * 60 * 60 * 1000;

export function assignmentHold(store, roomId, actorId, member) {
  if (!store.wakeQueue || !member || member.kind === "human" || member.id === actorId) return null;
  if (store.wakeQueue.pauseStatus(roomId, member.id)) {
    return new ServiceError(423, "assignment_paused", "This agent is paused. Leave the work available or choose an eligible member.");
  }

  // Infer silence only from the requester's own open asks. Another sender's
  // private activity must not affect the observable result of this write.
  // No tasks or probes are launched when this hold expires.
  const now = store.now();
  const cutoff = new Date(now - 2 * REPEATED_MISS_HOLD_MS).toISOString();
  const current = isCurrentRoom(store.db, roomId);
  const payload = current ? "payload" : "request.value";
  const table = current
    ? "current_room_records INDEXED BY current_inbox_open_requests"
    : "rooms, json_each(rooms.projection, '$.replyRequests') AS request";
  const scope = current ? "room_id=? AND domain='replyRequests'" : "rooms.id=?";
  const misses = store.db.prepare(`
    SELECT json_extract(${payload}, '$.createdAt') AS opened_at FROM ${table}
    WHERE ${scope} AND json_extract(${payload}, '$.status')='open'
      AND json_extract(${payload}, '$.recipientId')=? AND json_extract(${payload}, '$.requesterId')=?
      AND json_extract(${payload}, '$.acknowledgedAt') IS NULL
      AND json_extract(${payload}, '$.progressState') IS NULL
      AND json_extract(${payload}, '$.createdAt')>=?
    ORDER BY opened_at DESC LIMIT 2
  `).all(roomId, member.id, actorId, cutoff);
  if (!misses.length) return null;
  const lastResume = store.wakeQueue.lastResumeAt(roomId, member.id);
  const sinceResume = misses.map(row => Date.parse(row.opened_at))
    .filter(openedAt => lastResume === null || openedAt >= lastResume);
  if (!sinceResume.length || now - sinceResume.at(-1) <= ACK_WINDOW_MS) return null;
  const window = sinceResume.length === 1 ? STALE_AFTER_MS : REPEATED_MISS_HOLD_MS;
  if (now - sinceResume[0] >= window) return null;
  return new ServiceError(409, "assignment_waiting_for_recipient",
    "This agent has not acknowledged your previous request. Keep work available, or check and close the existing request before reassignment.");
}

export function assertAssignmentAvailable(store, roomId, actorId, member) {
  const hold = assignmentHold(store, roomId, actorId, member);
  if (hold) throw hold;
}

// Active pause for one member. Command admission asks isPaused before a
// non-human write. Reads and POST /agent-pause resume never reach it.
export function createAgentPause(wakeQueue) {
  return {
    isPaused(roomId, memberId) {
      return Boolean(wakeQueue?.pauseStatus?.(roomId, memberId));
    },
  };
}
