// UNIFY-R core (hw-h3-read-cursor-unify): one durable cursor per (member, stream).
// Reads never advance durable state; only ack/commit does (advance-only MAX).
// Migration folds disagreeing horizons with MIN. Flag: UNIFY_R_CURSOR (default on).
// Wire into store/http/MCP in a follow-up once file leases clear.

export const UNIFY_R_STREAMS = Object.freeze([
  "needs-me",
  "mentions",
  "updates",
  "mcp-messages",
]);

export function unifyREnabled(env = process.env) {
  const v = env?.UNIFY_R_CURSOR;
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
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

export function cursorKey(memberId, streamId) {
  if (typeof memberId !== "string" || !memberId) {
    throw new TypeError("memberId required");
  }
  if (!UNIFY_R_STREAMS.includes(streamId)) {
    throw new TypeError(`unknown streamId: ${streamId}`);
  }
  return `${memberId}::${streamId}`;
}

function normalizePos(p) {
  if (p == null || p === "") return null;
  if (typeof p === "number" && Number.isFinite(p) && p >= 0) return p;
  if (typeof p === "string" && /^\d+$/.test(p)) return Number(p);
  return null;
}

/** In-memory store for unit tests / scaffolding before SQLite wire-up. */
export function createMemoryReadCursorStore() {
  const durable = new Map(); // key -> number
  return {
    getReadCursor(memberId, streamId) {
      return durable.get(cursorKey(memberId, streamId)) ?? null;
    },
    ackReadCursor(memberId, streamId, pos) {
      const key = cursorKey(memberId, streamId);
      const next = ackDurableCursor(durable.get(key) ?? null, pos);
      if (next != null) durable.set(key, next);
      return next;
    },
    migrateFold(memberId, streamId, positions) {
      const key = cursorKey(memberId, streamId);
      const folded = foldHorizonsMin([durable.get(key) ?? null, ...(positions || [])]);
      if (folded != null) durable.set(key, folded);
      return folded;
    },
  };
}
