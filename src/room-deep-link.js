import { validId } from "./events.js";

// Public Room deep-link: #room/{roomId}
// Open and People honor this fragment. Query ?room= stays the account-home twin.

export const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const ROOM_HASH_PATTERN = /^#room\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/;
export const PUBLIC_ROOM_DOOR = "https://www.getdasha.com/room";

export function roomIdFromHash(hash) {
  const match = ROOM_HASH_PATTERN.exec(String(hash ?? ""));
  return match && ROOM_ID_PATTERN.test(match[1]) ? match[1] : null;
}

export function publicRoomDeepLink(roomId) {
  if (!ROOM_ID_PATTERN.test(String(roomId ?? ""))) return "";
  return `${PUBLIC_ROOM_DOOR}#room/${roomId}`;
}

export function selectedRoomFromLocation({ search = "", hash = "" } = {}) {
  const fromHash = roomIdFromHash(hash);
  if (fromHash) return fromHash;
  const query = String(search ?? "");
  const values = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query).getAll("room");
  return values.length === 1 && ROOM_ID_PATTERN.test(values[0]) ? values[0] : null;
}

// ?next= is an explicit post-login destination. A bare room id, or a path
// or URL that already carries ?room= / #room/, wins over the remembered room.
export function roomIdFromNext(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 2048) return null;
  if (ROOM_ID_PATTERN.test(raw)) return raw;
  try {
    const url = new URL(raw, "https://room.invalid");
    return selectedRoomFromLocation({ search: url.search, hash: url.hash });
  } catch {
    return null;
  }
}

export const ROOM_ACCESS_NOTICE = "You're not in that room yet. Ask a member for an invite, or request to join";

// Door Open/People must survive hash-dropping in-app browsers: keep ?room= and #room/.
export function roomOpenHandoffHref(href, hash, base) {
  const roomId = roomIdFromHash(hash);
  if (!roomId || href == null || href === "") return null;
  try {
    const url = new URL(href, base);
    url.searchParams.set("room", roomId);
    url.hash = `#room/${roomId}`;
    return url.href;
  } catch {
    return null;
  }
}

export function looksLikeSecretTitle(title) {
  const value = String(title ?? "").toLowerCase();
  return value.startsWith("pri_") || value.startsWith("ga1.")
    || value.startsWith("sk-") || value.includes("room_agent_");
}

export function authPanelTitle(roomId, title) {
  if (!roomId || !ROOM_ID_PATTERN.test(String(roomId))) return "PROJECT ROOM";
  const label = typeof title === "string" ? title.trim() : "";
  if (label && label.length <= 120 && !looksLikeSecretTitle(label)) return `Open ${label}`;
  return `Open room ${roomId}`;
}

export const KEY_KIND_HINT = "Room key: one room. Account key: Google or email across rooms.";

// Human invite URLs are #join/<43-char token>, never #room/{id} and never RM-.
// `location.origin` alone drops `/room` on www.getdasha.com.
const JOIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function humanJoinShareBase(locationLike = globalThis.location) {
  const origin = String(locationLike?.origin ?? "").replace(/\/$/, "");
  const path = String(locationLike?.pathname ?? "").replace(/\/index\.html$/, "").replace(/\/$/, "");
  return `${origin}${path}`;
}

export function publicJoinInviteHref(token, purposePath = "", locationLike = globalThis.location) {
  const secret = String(token ?? "");
  if (!JOIN_TOKEN_PATTERN.test(secret)) return "";
  const extra = typeof purposePath === "string" && purposePath.startsWith("/") ? purposePath : "";
  const hostname = locationLike?.hostname ?? "";
  const origin = String(locationLike?.origin ?? "").replace(/\/$/, "");
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
    || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])\b/i.test(origin);
  const pathAware = humanJoinShareBase(locationLike);
  // Keep created and personal links on the app host; getdasha roots use the door.
  const appHere = /^https:\/\//i.test(origin) && !/(^|\.)getdasha\.com$/i.test(hostname)
    && !/\.html$/i.test(pathAware);
  const base = local
    ? (pathAware || origin)
    : (pathAware.endsWith("/room") || appHere ? pathAware : PUBLIC_ROOM_DOOR);
  return `${base}/#join/${secret}${extra}`;
}

// Exact result links are selectors. The reader still checks room access and the pinned receipt.
export function exactResultDestination({ search = "", hash = "" }) {
  const route = /^#pr-record\/result\/([^/]+)\/([^/]+)$/.exec(hash);
  const rooms = new URLSearchParams(search).getAll("room");
  if (!route || rooms.length !== 1 || ![rooms[0], route[1], route[2]].every(validId)) return null;
  return { roomId: rooms[0], workItemId: route[1], completionEventId: route[2] };
}

export function exactResultHref({ roomId, workItemId, completionEventId }, locationLike = globalThis.location) {
  if (![roomId, workItemId, completionEventId].every(validId)) return "";
  const url = new URL(locationLike.origin);
  url.pathname = locationLike.pathname;
  url.searchParams.set("room", roomId);
  url.hash = ["pr-record", "result", workItemId, completionEventId].join("/");
  return url.href;
}

// Carry record selectors through agent sign-in. The chosen room still owns
// the post-login destination and the record reader still authorizes access.
export function agentSigninRecord({ search = "", hash = "" }) {
  const rooms = new URLSearchParams(search).getAll("room");
  if (rooms.length !== 1 || !validId(rooms[0])) return null;
  const exact = exactResultDestination({ search, hash });
  if (exact) return { roomId:exact.roomId, hash };
  const work = /^#pr-record\/work\/([^/]+)$/.exec(hash);
  if (!work) return null;
  try {
    const id = decodeURIComponent(work[1]);
    return validId(id) ? { roomId:rooms[0], hash:`#pr-record/work/${encodeURIComponent(id)}` } : null;
  } catch { return null; }
}
