// Tab-local navigation intent only. This never grants membership or restores
// identity; the current authenticated account must authorize the room on return.
const key = "project-room:google-room-return:v1";
import { ROOM_ID_PATTERN as roomPattern } from "./room-deep-link.js";
const ttl = 10 * 60 * 1000;
export function stashGoogleRoom(roomId, storage, now = Date.now()) {
  try {
    storage ??= globalThis.sessionStorage;
    storage.removeItem(key);
    if (typeof roomId === "string" && roomPattern.test(roomId)) storage.setItem(key, JSON.stringify({ roomId, at: now }));
  } catch { /* Storage-disabled browsers keep the server's fallback landing. */ }
}
export function consumeGoogleRoom(storage, now = Date.now()) {
  try {
    storage ??= globalThis.sessionStorage;
    const raw = storage.getItem(key);
    storage.removeItem(key);
    const value = JSON.parse(raw);
    if (typeof value?.roomId !== "string" || !roomPattern.test(value.roomId)
      || !Number.isFinite(value.at) || now < value.at || now - value.at > ttl) return null;
    return value.roomId;
  } catch { return null; }
}
