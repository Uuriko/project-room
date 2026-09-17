// Machine-readable room activity feed (B025). A pure activity-feed
// builder: collect room events, filter by type/actor, and emit a JSON
// feed (array of event records) for agent consumption. Supports cursor-
// based pagination. The module is pure and dependency-free. Frozen
// outputs; malformed inputs throw FeedError. HTTP endpoint wiring is a
// later slice.
class FeedError extends Error { constructor(code, message) { super(message); this.name = "FeedError"; this.code = code; } }
const fail = (code, message) => { throw new FeedError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_feed", message); };
// Normalize a raw event into a feed record.
export function toFeedRecord({ event }) {
  check(event !== null && typeof event === "object", "event must be an object");
  check(typeof event.eventId === "string" && event.eventId.length > 0,
    "event must have eventId");
  check(typeof event.eventType === "string" && event.eventType.length > 0,
    "event must have eventType");
  check(typeof event.timestamp === "string" && event.timestamp.length > 0,
    "event must have timestamp");
  return Object.freeze({
    eventId: event.eventId, eventType: event.eventType, timestamp: event.timestamp,
    actorId: event.actorId ?? null, data: Object.freeze({ ...(event.data ?? {}) }),
  });
}
// Build a feed page. events is an array (already ordered newest-first).
// cursor is an eventId to start after (exclusive). limit caps the page.
export function buildFeed({ events, cursor, limit = 50, eventTypes, actorId }) {
  check(Array.isArray(events), "events must be an array");
  check(cursor === undefined || (typeof cursor === "string" && cursor.length > 0),
    "cursor must be a non-empty string if given");
  check(Number.isInteger(limit) && limit > 0 && limit <= 200, "limit must be 1-200");
  check(eventTypes === undefined || (Array.isArray(eventTypes) &&
    eventTypes.every(t => typeof t === "string" && t.length > 0)),
    "eventTypes must be a string array if given");
  check(actorId === undefined || (typeof actorId === "string" && actorId.length > 0),
    "actorId must be a non-empty string if given");
  let filtered = events.map(e => toFeedRecord({ event: e }));
  if (eventTypes) {
    const types = new Set(eventTypes);
    filtered = filtered.filter(r => types.has(r.eventType));
  }
  if (actorId) filtered = filtered.filter(r => r.actorId === actorId);
  let startIndex = 0;
  if (cursor) {
    const cursorIndex = filtered.findIndex(r => r.eventId === cursor);
    check(cursorIndex >= 0, `unknown cursor "${cursor}"`);
    startIndex = cursorIndex + 1;
  }
  const page = filtered.slice(startIndex, startIndex + limit);
  const nextCursor = startIndex + limit < filtered.length
    ? page[page.length - 1].eventId : null;
  return Object.freeze({ events: Object.freeze(page),
    nextCursor, hasMore: nextCursor !== null, total: filtered.length });
}
export { FeedError };
