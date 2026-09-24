// Session-expiry rendering shared by the join page and the room app.
//
// expiresAt is epoch milliseconds supplied by the server — sessionView.expiresAt
// (GET/POST /api/session), accountView.expiresAt (GET/POST /api/account-session),
// or the join response's sessionExpiresAt. It is always the genuine expiry the
// session row was created with (8h from issue for browser sessions); the client
// never invents or estimates one.

export function validSessionExpiry(expiresAt) {
  return Number.isSafeInteger(expiresAt) && expiresAt > 0 ? expiresAt : null;
}

// -> the expiry as a date/time in the user's locale, or null when the server
// did not supply a usable one (the caller hides the line instead of guessing).
export function formatSessionExpiry(expiresAt) {
  const at = validSessionExpiry(expiresAt);
  if (at === null) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}
