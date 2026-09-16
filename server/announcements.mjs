// Room announcements (K018). A pure announcement channel: owners broadcast
// low-noise announcements; members get a digest of unread announcements.
// Announcements are pinned and cannot be replied to (broadcast-only).
// All state is caller-owned (a Map); the module is pure and dependency-
// free. Frozen outputs; malformed inputs throw AnnouncementError. Channel
// UI wiring is a later slice.
class AnnouncementError extends Error { constructor(code, message) { super(message); this.name = "AnnouncementError"; this.code = code; } }
const fail = (code, message) => { throw new AnnouncementError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_announcement", message); };
// Create an announcement manager. store is a caller-owned Map (roomId -> { announcements, readBy }).
export function createAnnouncements({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const rooms = store ?? new Map();
  let announcementCounter = 0;
  const getRoom = roomId => {
    check(typeof roomId === "string" && roomId.length > 0, "roomId must be a non-empty string");
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { announcements: [], readBy: new Map() });
    }
    return rooms.get(roomId);
  };
  // Post an announcement (owner only — caller enforces ownership).
  const post = (roomId, { authorId, title, body }) => {
    const room = getRoom(roomId);
    check(typeof authorId === "string" && authorId.length > 0, "authorId must be a non-empty string");
    check(typeof title === "string" && title.trim().length > 0, "title must be a non-empty string");
    check(typeof body === "string" && body.trim().length > 0, "body must be a non-empty string");
    const announcement = Object.freeze({ announcementId: `ann-${++announcementCounter}`,
      roomId, authorId, title: title.trim(), body: body.trim() });
    room.announcements.push(announcement);
    return announcement;
  };
  // Mark an announcement as read by a member.
  const markRead = (roomId, { announcementId, memberId }) => {
    const room = getRoom(roomId);
    check(typeof announcementId === "string" && announcementId.length > 0,
      "announcementId must be a non-empty string");
    check(typeof memberId === "string" && memberId.length > 0, "memberId must be a non-empty string");
    check(room.announcements.some(a => a.announcementId === announcementId),
      `unknown announcement "${announcementId}"`);
    if (!room.readBy.has(announcementId)) room.readBy.set(announcementId, new Set());
    room.readBy.get(announcementId).add(memberId);
    return Object.freeze({ announcementId, memberId, read: true });
  };
  // List unread announcements for a member.
  const unread = (roomId, { memberId }) => {
    const room = getRoom(roomId);
    check(typeof memberId === "string" && memberId.length > 0, "memberId must be a non-empty string");
    return Object.freeze(room.announcements.filter(a => {
      const readers = room.readBy.get(a.announcementId);
      return !readers || !readers.has(memberId);
    }));
  };
  // List all announcements (newest first).
  const list = roomId => Object.freeze([...getRoom(roomId).announcements].reverse());
  return Object.freeze({ post, markRead, unread, list });
}
export { AnnouncementError };
