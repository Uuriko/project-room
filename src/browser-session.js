// Browser session hints: remembered room id + what Sign out must clear.
// Cookies are HttpOnly (room_session / account_session). These keys are the
// only client-owned session leftovers. Never store secrets here.

import { ROOM_ID_PATTERN, looksLikeSecretTitle } from "./room-deep-link.js";

export const LAST_ROOM_KEY = "pr-last-room";
export const LAST_ROOM_TITLE_KEY = "pr-last-room-title";
export const LAST_ROOM_BY_MEMBER_KEY = "pr-last-room-by-member";
export const HAD_ACCOUNT_KEY = "pr-had-account";
export const AUTH_KIND_KEY = "pr-auth-kind";
export const GUIDE_DISMISSED_KEY = "pr-guide-dismissed";

export const SESSION_HINT_COPY = "This browser keeps an HttpOnly session cookie — not localStorage. Closing the tab does not sign you out. Room-key sessions and account sessions each stay signed in for up to 8 hours. Sign out clears the cookie. The last room for this account stays in this browser so the next sign-in can return there.";

function safeRoomTitle(title) {
  const value = typeof title === "string" ? title.trim() : "";
  if (!value || value.length > 120 || looksLikeSecretTitle(value)) return null;
  return value;
}

export function rememberLastRoom(roomId, storage, title) {
  if (!ROOM_ID_PATTERN.test(String(roomId ?? ""))) return false;
  const store = storage ?? globalThis.localStorage;
  try {
    store.setItem(LAST_ROOM_KEY, roomId);
    const label = safeRoomTitle(title);
    if (label) store.setItem(LAST_ROOM_TITLE_KEY, label);
    else store.removeItem(LAST_ROOM_TITLE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function rememberAccountHint(storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(HAD_ACCOUNT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function readAccountHint(storage) {
  try {
    return (storage ?? globalThis.localStorage).getItem(HAD_ACCOUNT_KEY) === "1";
  } catch {
    return false;
  }
}

// First-paint session probe gate (QAU-006): the remembered room id and the
// account hint are the only client-side signals that a session cookie could
// exist for this browser. Firing GET /api/session without one can only 401,
// which the browser logs as a console error on the welcome screen — so the
// probe is skipped and the signed-out state renders directly.
export function hasSessionHint(storage) {
  return Boolean(readLastRoom(storage) || readAccountHint(storage));
}

export function readLastRoom(storage) {
  try {
    const value = (storage ?? globalThis.localStorage).getItem(LAST_ROOM_KEY);
    return ROOM_ID_PATTERN.test(String(value ?? "")) ? value : null;
  } catch {
    return null;
  }
}

export function readLastRoomTitle(roomId, storage) {
  if (roomId && readLastRoom(storage) !== roomId) return null;
  try {
    return safeRoomTitle((storage ?? globalThis.localStorage).getItem(LAST_ROOM_TITLE_KEY));
  } catch {
    return null;
  }
}

const MEMBER_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function readMemberRoomMap(storage) {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(LAST_ROOM_BY_MEMBER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!MEMBER_KEY.test(key)) continue;
      const roomId = value?.roomId;
      if (!ROOM_ID_PATTERN.test(String(roomId ?? ""))) continue;
      const title = safeRoomTitle(value?.title);
      map[key] = title ? { roomId, title } : { roomId };
    }
    return map;
  } catch {
    return {};
  }
}

// Per-user last room. Sign-out clears the shared pr-last-room hint so the
// welcome page does not offer someone else's room, and leaves this map so
// the same account returns there. The key is the account id when the member
// is signed in, and the room member id as well.
export function rememberMemberRoom(memberId, roomId, storage, title) {
  if (!MEMBER_KEY.test(String(memberId ?? ""))) return false;
  if (!ROOM_ID_PATTERN.test(String(roomId ?? ""))) return false;
  const store = storage ?? globalThis.localStorage;
  try {
    const map = readMemberRoomMap(store);
    const label = safeRoomTitle(title);
    map[memberId] = label ? { roomId, title: label } : { roomId };
    const keys = Object.keys(map);
    while (keys.length > 20) delete map[keys.shift()];
    store.setItem(LAST_ROOM_BY_MEMBER_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

export function readMemberRoom(memberId, storage) {
  if (!MEMBER_KEY.test(String(memberId ?? ""))) return null;
  return readMemberRoomMap(storage)[memberId] ?? null;
}

// Explicit ?next= and a deep-linked room beat the remembered room. No target
// means the account home (Inbox).
export function signInRoomTarget({ nextRoom = null, deepLinkRoom = null, rememberedRoom = null } = {}) {
  if (nextRoom) return { roomId: nextRoom, explicit: true, source: "next" };
  if (deepLinkRoom) return { roomId: deepLinkRoom, explicit: true, source: "deep-link" };
  if (rememberedRoom) return { roomId: rememberedRoom, explicit: false, source: "last" };
  return { roomId: null, explicit: false, source: "inbox" };
}

export function clearStoredPasswords(session) {
  const store = session ?? globalThis.sessionStorage;
  const removed = [];
  try {
    const keys = [];
    for (let index = 0; index < (store?.length ?? 0); index += 1) keys.push(store.key(index));
    for (const key of keys) {
      if (key && /password/i.test(key)) {
        store.removeItem(key);
        removed.push(key);
      }
    }
  } catch { /* private-mode / blocked storage */ }
  return removed;
}

export function clearBrowserSessionHints({ localStorage: local, sessionStorage: session } = {}) {
  const localStore = local ?? globalThis.localStorage;
  const sessionStore = session ?? globalThis.sessionStorage;
  const cleared = [];
  try {
    localStore?.removeItem?.(LAST_ROOM_KEY);
    localStore?.removeItem?.(LAST_ROOM_TITLE_KEY);
    localStore?.removeItem?.(HAD_ACCOUNT_KEY);
    cleared.push(LAST_ROOM_KEY, LAST_ROOM_TITLE_KEY, HAD_ACCOUNT_KEY);
  } catch { /* private-mode / blocked storage */ }
  try {
    sessionStore?.removeItem?.(AUTH_KIND_KEY);
    sessionStore?.removeItem?.(GUIDE_DISMISSED_KEY);
    cleared.push(AUTH_KIND_KEY, GUIDE_DISMISSED_KEY);
  } catch { /* private-mode / blocked storage */ }
  return cleared;
}
