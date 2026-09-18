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
