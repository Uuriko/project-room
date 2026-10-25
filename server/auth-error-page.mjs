// DOOR-CURE-2 (stranger-door D1 rows 4-5): readable HTML for API-shaped
// auth failures reached by browser navigation.
//
// The auth surface's failures are raised as ServiceError and rendered by
// server/http.mjs's catch block as a JSON envelope — correct for API
// clients, unreadable when a stranger's browser lands on the URL directly
// (typed/guessed links, clicks through a failed signin-options feed). This
// module owns the negotiation decision (auth path + evidenced status) and
// the page shape; the HTTP layer supplies the Accept preference via the
// existing acceptPrefersHtml helper (server/public-search.mjs), so
// Accept: */* and application/json clients keep the JSON envelope
// byte-for-byte. The page mirrors githubUnavailablePage's posture: no
// scripts, no styles, one link back to the sign-in surface, and the error
// code/message/hint rendered as escaped text — never tokens, never
// request data beyond what the JSON envelope itself would have shown.

// The shapes D1 row 5 evidenced on the auth surface: unknown provider
// (404), wrong method (405), missing Origin (403), unconfigured provider
// (503). Other statuses (401/422/429/5xx internals) keep the envelope:
// they are either API-flow answers a browser navigation does not
// meaningfully land on, or operator-shaped failures.
export const AUTH_ERROR_HTML_STATUSES = new Set([403, 404, 405, 503]);

// True when a failed request belongs to the auth surface. The caller
// passes the pathname AFTER the /room prefix rewrite, matching how the
// catch block resolves routes.
export function isAuthErrorPath(pathname) {
  return typeof pathname === "string"
    && (pathname === "/api/auth" || pathname.startsWith("/api/auth/"));
}

// The negotiation decision minus the Accept preference, which the HTTP
// layer owns: HTML only for auth-surface failures with an evidenced
// status.
export function authErrorHtmlApplies(pathname, status) {
  return isAuthErrorPath(pathname) && AUTH_ERROR_HTML_STATUSES.has(status);
}

const HEADINGS = {
  403: "That sign-in request was refused",
  404: "That sign-in link does not exist",
  405: "That sign-in link cannot be opened that way",
  503: "Sign-in is not available right now",
};

const escapeHtml = value => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Readable landing for a browser navigation that hit an auth failure.
// `message` and `hint` come from the same envelope the API client would
// have received, so the page says nothing the JSON did not already say.
export function authErrorPage({ status, code, message, hint } = {}) {
  const heading = HEADINGS[status] ?? "Sign-in hit a problem";
  const detail = typeof message === "string" && message ? message : "Sign-in could not continue.";
  const hintHtml = typeof hint === "string" && hint ? `<p>${escapeHtml(hint)}</p>` : "";
  const codeHtml = typeof code === "string" && code ? `<p><small>Error: ${escapeHtml(code)}</small></p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p>${hintHtml}${codeHtml}<p><a href="/?account=1">Back to sign-in</a></p></main></body></html>`;
}
