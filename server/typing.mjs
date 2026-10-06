// Ephemeral typing indicators. In-memory only: heartbeats are never persisted,
// never enter the event log, and expire after TYPING_TTL_MS. The SSE pump
// prunes on read, so a dead client stops appearing without any explicit stop.
//
// state: Map(roomId -> Map(memberId -> { displayName, kind, expiresAt }))

export const TYPING_TTL_MS = 10_000;

// Shared in-memory heartbeat state, owned by this module so both the POST
// route (server/routes/typing.mjs) and the SSE pump (server/http.mjs) see
// the same beats. Never persisted, never logged.
export const typingBeats = new Map();

export function recordBeat(state, roomId, member, nowMs = Date.now()) {
  if (!roomId || !member?.id) return false;
  let room = state.get(roomId);
  if (!room) {
    room = new Map();
    state.set(roomId, room);
  }
  room.set(member.id, {
    displayName: member.displayName || member.id,
    kind: member.kind || "human",
    expiresAt: nowMs + TYPING_TTL_MS,
  });
  return true;
}

export function currentTypists(state, roomId, excludeId, nowMs = Date.now()) {
  const room = state.get(roomId);
  if (!room) return [];
  const out = [];
  for (const [id, beat] of room) {
    if (beat.expiresAt <= nowMs) {
      room.delete(id);
      continue;
    }
    if (id === excludeId) continue;
    out.push({ memberId: id, displayName: beat.displayName, kind: beat.kind });
  }
  if (room.size === 0) state.delete(roomId);
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function typingKey(typists) {
  return typists.map(t => t.memberId).join(",");
}
