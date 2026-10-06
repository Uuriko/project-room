// UNIFY-R scalar foundation. Stream adapters and durable storage are not enabled.
// Reads never advance durable state; only ack/commit does (advance-only MAX).
// Numeric migration folds disagreeing horizons with MIN. Flag defaults OFF.
// Opaque compound cursors remain on their existing per-room/thread protocols.

export const UNIFY_R_STREAMS = Object.freeze([
  "needs-me",
  "mentions",
  "updates",
  "mcp-messages",
]);

export function unifyREnabled(env = globalThis.process?.env ?? {}) {
  return typeof env?.UNIFY_R_CURSOR === "string" && /^(1|true|on)$/i.test(env.UNIFY_R_CURSOR);
}

/** Session-local watermark: may lag durable; must not write below durable. */
export function sessionWatermark(durablePos, sessionPos) {
  const d = normalizePos(durablePos);
  const s = normalizePos(sessionPos);
  if (s == null) return d;
  if (d == null) return s;
  return Math.max(d, s);
}

/** Durable ack: advance-only MAX. Regress is a no-op. */
export function ackDurableCursor(durablePos, ackPos) {
  const d = normalizePos(durablePos);
  const a = normalizePos(ackPos);
  if (a == null) return d;
  if (d == null) return a;
  return Math.max(d, a);
}

/**
 * Migration fold: when old stores disagree, take MIN so no host skips unread work.
 * Null/undefined entries are ignored; empty -> null.
 */
export function foldHorizonsMin(positions) {
  const nums = (positions || [])
    .map(normalizePos)
    .filter((p) => p != null);
  if (!nums.length) return null;
  return Math.min(...nums);
}

export function cursorKey(memberId, streamId, { roomId, threadId = "" } = {}) {
  if (typeof roomId !== "string" || !roomId) throw new TypeError("roomId required");
  if (typeof threadId !== "string") throw new TypeError("threadId must be a string");
  if (typeof memberId !== "string" || !memberId) {
    throw new TypeError("memberId required");
  }
  if (!UNIFY_R_STREAMS.includes(streamId)) {
    throw new TypeError(`unknown streamId: ${streamId}`);
  }
  return JSON.stringify([roomId, memberId, streamId, threadId]);
}

function normalizePos(p) {
  if (p == null || p === "") return null;
  if (typeof p === "number" && Number.isSafeInteger(p) && p >= 0) return p;
  if (typeof p === "string" && /^\d+$/.test(p)) { const value = Number(p); return Number.isSafeInteger(value) ? value : null; }
  return null;
}

/** In-memory store for unit tests / scaffolding before SQLite wire-up. */
export function createMemoryReadCursorStore(scope) {
  cursorKey("fixture", UNIFY_R_STREAMS[0], scope);
  const durable = new Map(); // key -> number
  return {
    getReadCursor(memberId, streamId) {
      return durable.get(cursorKey(memberId, streamId, scope)) ?? null;
    },
    ackReadCursor(memberId, streamId, pos) {
      const key = cursorKey(memberId, streamId, scope);
      const next = ackDurableCursor(durable.get(key) ?? null, pos);
      if (next != null) durable.set(key, next);
      return next;
    },
    migrateFold(memberId, streamId, positions) {
      const key = cursorKey(memberId, streamId, scope);
      const folded = foldHorizonsMin([durable.get(key) ?? null, ...(positions || [])]);
      if (folded != null) durable.set(key, folded);
      return folded;
    },
  };
}
