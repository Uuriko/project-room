// Unified inbox view (A008, first half). A pure view builder: given the
// message lists of several connections (Graph, Gmail, Telegram, WhatsApp),
// it merges them into one newest-first inbox with per-connection
// attribution, id dedup, and cursor pagination. No store reads or writes —
// the caller supplies the per-connection lists, so this stays a pure
// function; store wiring is a later slice.
class UnifiedInboxError extends Error { constructor(code, message) { super(message); this.name = "UnifiedInboxError"; this.code = code; } }
const fail = (code, message) => { throw new UnifiedInboxError(code, message); };
const requireView = (condition, message = "invalid unified inbox input") => { if (!condition) fail("invalid_unified_inbox", message); };

const isoDate = value => {
  requireView(typeof value === "string" && Number.isFinite(Date.parse(value)), "message occurredAt must be a parseable timestamp");
  return value;
};
const messageRef = value => {
  requireView(value !== null && typeof value === "object" && !Array.isArray(value), "messages must be objects");
  requireView(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512, "message id must be 1..512 characters");
  return { id: value.id, occurredAt: isoDate(value.occurredAt), envelope: value };
};
const connectionList = value => {
  requireView(value !== null && typeof value === "object" && !Array.isArray(value), "connections must be objects");
  requireView(typeof value.connectionId === "string" && value.connectionId.length > 0, "connectionId must be text");
  requireView(typeof value.channel === "string" && value.channel.length > 0, "channel must be text");
  requireView(Array.isArray(value.messages) && value.messages.length <= 10000, "messages must be a list of at most 10000");
  return { connectionId: value.connectionId, channel: value.channel, messages: value.messages.map(messageRef) };
};
const limitOf = value => {
  if (value === undefined || value === null) return 50;
  requireView(Number.isInteger(value) && value >= 1 && value <= 200, "limit must be an integer 1..200");
  return value;
};
// Cursor: { occurredAt, id } of the last item on the previous page.
const cursorOf = value => {
  if (value === undefined || value === null) return null;
  requireView(value !== null && typeof value === "object", "cursor must be an object");
  return { occurredAt: isoDate(value.occurredAt), id: String(value.id) };
};
const before = (item, cursor) => item.occurredAt < cursor.occurredAt
  || (item.occurredAt === cursor.occurredAt && item.id < cursor.id);
// Build the unified view. Items carry connectionId + channel so the UI can
// badge each row; dedup keeps the newest copy when two connections mirror
// the same message id (deterministic tie-break on connectionId).
export function buildUnifiedView(connections, { limit, cursor } = {}) {
  requireView(Array.isArray(connections) && connections.length <= 64, "connections must be a list of at most 64");
  const take = limitOf(limit), after = cursorOf(cursor);
  const seen = new Map();
  for (const connection of connections.map(connectionList)) {
    for (const message of connection.messages) {
      const item = Object.freeze({ ...message.envelope, id: message.id, occurredAt: message.occurredAt,
        connectionId: connection.connectionId, channel: connection.channel });
      const existing = seen.get(item.id);
      if (!existing || item.occurredAt > existing.occurredAt
        || (item.occurredAt === existing.occurredAt && item.connectionId < existing.connectionId)) seen.set(item.id, item);
    }
  }
  const sorted = [...seen.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const page = (after ? sorted.filter(item => before(item, after)) : sorted).slice(0, take + 1);
  const items = page.slice(0, take);
  const last = items[items.length - 1];
  return Object.freeze({ items: Object.freeze(items), totalCount: sorted.length,
    nextCursor: page.length > take && last ? Object.freeze({ occurredAt: last.occurredAt, id: last.id }) : null });
}
export { UnifiedInboxError };
