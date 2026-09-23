// Invitation context across OAuth navigations (quality-run RC-2026-09-18-007).
//
// The #invite/<token> fragment never reaches the server, so a signed-out
// invitee who chooses Google/GitHub OAuth would lose the invitation through
// the round-trip: the post-login page refreshes to /?room=X or /?account=1
// without the hash, and the in-memory invitation object is gone with the old
// document. The secret is stashed into sessionStorage ONLY at the exact
// moment an OAuth navigation starts (never on mere preview — the raw token
// must not linger in web storage), and boot restores it one-shot when
// landing without a room context, so the dialog re-opens after OAuth sign-in.
//
// Side-effect-free: storage and location parts are passed in, so these are
// unit-testable without a browser.

export const PENDING_INVITE_KEY = "pr-pending-invite";

const INVITE_FRAGMENT_PATTERN = /^#invite\/[A-Za-z0-9_-]{43}$/;
const INVITE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Mirror the invitation secret at OAuth-start so the round-trip cannot drop
// it. Called only from the OAuth entry points — never on invitation preview.
export function stashPendingInvite(storage, secret) {
  if (!storage || typeof secret !== "string" || !INVITE_SECRET_PATTERN.test(secret)) return;
  try { storage.setItem(PENDING_INVITE_KEY, `#invite/${secret}`); } catch { /* storage unavailable */ }
}

// Drop the mirror: the invitation was accepted, dismissed, or superseded.
export function clearPendingInvite(storage) {
  if (!storage) return;
  try { storage.removeItem(PENDING_INVITE_KEY); } catch { /* storage unavailable */ }
}

// One-shot restore for boot: returns { valid: true, secret } when a stashed
// invitation should be re-opened, else null. Always consumes the stash.
// Never restores over an existing invite hash or an active room landing —
// a member who lands in a room keeps their session undisturbed.
export function takeRestoredInvite({ storage, hash, search }) {
  let pending = null;
  try {
    pending = storage?.getItem(PENDING_INVITE_KEY) ?? null;
    storage?.removeItem(PENDING_INVITE_KEY);
  } catch { return null; }
  if (typeof pending !== "string" || !INVITE_FRAGMENT_PATTERN.test(pending)) return null;
  if (typeof hash === "string" && hash.startsWith("#invite/")) return null;
  if (typeof hash === "string" && /^#room\/[A-Za-z0-9]/.test(hash)) return null;
  if (typeof search === "string" && /(^|[?&])room=/.test(search)) return null;
  return { valid: true, secret: pending.slice("#invite/".length) };
}

// ---------------------------------------------------------------------------
// [QA-Join]: join-link context across OAuth navigations.
//
// The #join/<token> share-link fragment has the same round-trip problem as
// #invite/: it never reaches the server, so a signed-out invitee who closes
// the join dialog to sign in via Google/GitHub OAuth loses the invitation
// through the round-trip (the dialog-close handler restores the fragment to
// the address bar, but the cross-origin OAuth navigation drops it). Without
// a stash the post-login landing has no room context, and the first-sign-in
// default-room flow would create "My first room" instead of re-opening the
// invite — the stranger never joins the room they were invited to. Mirror
// the #invite/ contract: stash the live join fragment at OAuth start (only
// then — never on mere preview), restore one-shot at boot when landing
// without a room context.

export const PENDING_JOIN_KEY = "pr-pending-join";

// #join/<43-char token> with the optional purpose focus (#join/<token>/work/<id>
// or /message/<id>). The fragment never leaves the browser, so the raw token
// may touch sessionStorage only for the OAuth round-trip.
const JOIN_FRAGMENT_PATTERN = /^#join\/[A-Za-z0-9_-]{43}(\/(work|message)\/[^/?#]+)?$/;

// Mirror the join fragment at OAuth-start so the round-trip cannot drop it.
// Called only from the OAuth entry points — never on invitation preview.
export function stashPendingJoin(storage, fragment) {
  if (!storage || typeof fragment !== "string" || !JOIN_FRAGMENT_PATTERN.test(fragment)) return;
  try { storage.setItem(PENDING_JOIN_KEY, fragment); } catch { /* storage unavailable */ }
}

// Drop the mirror: the join completed, was dismissed, or was superseded.
export function clearPendingJoin(storage) {
  if (!storage) return;
  try { storage.removeItem(PENDING_JOIN_KEY); } catch { /* storage unavailable */ }
}

// One-shot restore for boot: returns { valid: true, fragment } when a stashed
// join link should be re-opened, else null. Always consumes the stash.
// Never restores over a fresh #join/ or #invite/ hash or an active room
// landing — a member who lands in a room keeps their session undisturbed, and
// a freshly opened link always wins over a stale stash.
export function takeRestoredJoin({ storage, hash, search }) {
  let pending = null;
  try {
    pending = storage?.getItem(PENDING_JOIN_KEY) ?? null;
    storage?.removeItem(PENDING_JOIN_KEY);
  } catch { return null; }
  if (typeof pending !== "string" || !JOIN_FRAGMENT_PATTERN.test(pending)) return null;
  if (typeof hash === "string" && (hash.startsWith("#join/") || hash.startsWith("#invite/"))) return null;
  if (typeof hash === "string" && /^#room\/[A-Za-z0-9]/.test(hash)) return null;
  if (typeof search === "string" && /(^|[?&])room=/.test(search)) return null;
  return { valid: true, fragment: pending };
}

// ---------------------------------------------------------------------------
// RC-2026-09-19-071 (QAJ-001): the request-access door.
//
// A bad/expired invitation dialog used to be a dead end ("ask a current Room
// administrator" — but the stranger knows no administrator). When the
// invitation preview names the room (expired/revoked/stale statuses still
// carry roomId), the dialog offers a "Request access" door: the stranger
// files a self-serve access request against that room instead of bouncing.
//
// Pure helpers, same contract as above: storage and values are passed in so
// these stay unit-testable without a browser. The network calls
// (identity mint + access-request POST) live in the UI layer.

// Invitation statuses whose dialog is a dead end WITH a known room: the
// request has somewhere to go. "pending"/"accepted" have their own flows;
// a missing preview means the room is unknown and the door stays shut.
export const REQUESTABLE_INVITE_STATUSES = Object.freeze(["expired", "revoked", "stale"]);

// Returns { roomId, roomTitle } when the dead-invite dialog should offer the
// request-access door, else null.
export function inviteRequestDoor(preview) {
  if (!preview || typeof preview !== "object") return null;
  if (typeof preview.roomId !== "string" || !preview.roomId) return null;
  if (!REQUESTABLE_INVITE_STATUSES.includes(preview.status)) return null;
  return { roomId: preview.roomId, roomTitle: preview.roomTitle || "Project Room" };
}

// The permissions a stranger asks for: what the dead invitation would have
// granted, falling back to a minimal ask when the preview carries none. The
// owner still chooses the final grant at decision time.
export const FALLBACK_REQUEST_PERMISSIONS = Object.freeze(["accept_work"]);
export function defaultRequestPermissions(preview) {
  const fromInvite = Array.isArray(preview?.permissions) ? preview.permissions.filter(p => typeof p === "string" && p) : [];
  return fromInvite.length ? fromInvite : [...FALLBACK_REQUEST_PERMISSIONS];
}

// Client-side mirror of the server's displayName/note limits, so the form
// fails fast before any network call.
export const ACCESS_REQUEST_NAME_MAX = 80;
export const ACCESS_REQUEST_NOTE_MAX = 500;
export function validateAccessRequestForm({ displayName, note, referredBy }) {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (!name) return { ok: false, error: "Enter the display name the room owner will see." };
  if (name.length > ACCESS_REQUEST_NAME_MAX) return { ok: false, error: `Display name must be at most ${ACCESS_REQUEST_NAME_MAX} characters.` };
  if (note !== undefined && note !== null && note !== "") {
    if (typeof note !== "string" || note.length > ACCESS_REQUEST_NOTE_MAX) {
      return { ok: false, error: `Note must be at most ${ACCESS_REQUEST_NOTE_MAX} characters.` };
    }
  }
  // "Who referred you?" — optional free text, matched against member display
  // names at approval time; never blocks the join.
  if (referredBy !== undefined && referredBy !== null && referredBy !== "") {
    if (typeof referredBy !== "string" || referredBy.length > ACCESS_REQUEST_NAME_MAX) {
      return { ok: false, error: `Referrer name must be at most ${ACCESS_REQUEST_NAME_MAX} characters.` };
    }
  }
  return { ok: true, displayName: name, note: typeof note === "string" && note.trim() ? note.trim() : null,
    referredBy: typeof referredBy === "string" && referredBy.trim() ? referredBy.trim() : null };
}

// Idempotency-key mint for the access request. Same shape as the server's
// default (ar_ + 16 hex chars) so either side can originate it.
export function newAccessRequestId() {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `ar_${random.replaceAll("-", "").slice(0, 16)}`;
}

// Per-room stash of the requester's minted identity + request id, so a
// retry or a later status check reuses the same identity instead of minting
// (and rate-limit-burning) a new one per click.
export const accessRequestStorageKey = roomId => `pr-access-request:${roomId}`;
export function stashAccessRequest(storage, roomId, record) {
  if (!storage || typeof roomId !== "string" || !roomId || !record || typeof record !== "object") return;
  const { identityId, secret, requestId, displayName } = record;
  if (typeof identityId !== "string" || !identityId || typeof requestId !== "string" || !requestId) return;
  try {
    storage.setItem(accessRequestStorageKey(roomId), JSON.stringify({ identityId, secret: secret ?? null, requestId, displayName: displayName ?? null }));
  } catch { /* storage unavailable */ }
}
// Read without consuming: status checks need the record after the submit.
export function readAccessRequest(storage, roomId) {
  if (!storage || typeof roomId !== "string" || !roomId) return null;
  let raw = null;
  try { raw = storage.getItem(accessRequestStorageKey(roomId)); } catch { return null; }
  if (typeof raw !== "string" || !raw) return null;
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record.identityId !== "string" || !record.identityId
      || typeof record.requestId !== "string" || !record.requestId) return null;
    return record;
  } catch { return null; }
}
