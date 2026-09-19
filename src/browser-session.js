// Browser session hints: remembered room id + what Sign out must clear.
// Cookies are HttpOnly (room_session / account_session). These keys are the
// only client-owned session leftovers. Never store secrets here.

import { ROOM_ID_PATTERN, looksLikeSecretTitle } from "./room-deep-link.js";

export const LAST_ROOM_KEY = "pr-last-room";
export const LAST_ROOM_TITLE_KEY = "pr-last-room-title";
export const HAD_ACCOUNT_KEY = "pr-had-account";
export const AUTH_KIND_KEY = "pr-auth-kind";
export const GUIDE_DISMISSED_KEY = "pr-guide-dismissed";

export const SESSION_HINT_COPY = "This browser keeps an HttpOnly session cookie — not localStorage. Closing the tab does not sign you out. Account sessions stay signed in for up to 8 hours. Sign out clears the cookie and any remembered room.";

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
