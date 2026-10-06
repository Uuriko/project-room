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

// Admission bounds (Instinct-3, muse-room 3509): beats live in process memory,
// so the map is capped. A full map is swept of expired beats first; a beat
// that still does not fit is refused, never evicting a live typist.
export const MAX_TYPING_ROOMS = 10_000;
export const MAX_TYPISTS_PER_ROOM = 200;

function sweepExpired(state, nowMs) {
  for (const [roomId, room] of state) {
    for (const [id, beat] of room) if (beat.expiresAt <= nowMs) room.delete(id);
    if (room.size === 0) state.delete(roomId);
  }
}

export function recordBeat(state, roomId, member, nowMs = Date.now()) {
  if (!roomId || !member?.id) return false;
  let room = state.get(roomId);
  if (!room && state.size >= MAX_TYPING_ROOMS) {
    sweepExpired(state, nowMs);
    if (state.size >= MAX_TYPING_ROOMS) return false;
  }
  if (room && !room.has(member.id) && room.size >= MAX_TYPISTS_PER_ROOM) {
    for (const [id, beat] of room) if (beat.expiresAt <= nowMs) room.delete(id);
    if (room.size >= MAX_TYPISTS_PER_ROOM) return false;
  }
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
