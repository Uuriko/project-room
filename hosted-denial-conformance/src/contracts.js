/**
 * Expected status / code / copy contracts observed on PR #23 tip
 * fb90a7083e9f5866c8df242778a6a72f4a58536d.
 *
 * Copied here as fixtures so this package can assert the contract without
 * importing server/, src/, or cloudflare/. Do not treat this as a second
 * implementation of share-links.
 */

export const ERROR_ENVELOPE = Object.freeze({
  shape: "{ error: { code, message } }",
  source: "server/http.mjs catch → json(res, error.status, { error: { code, message } })"
});

export const LINK_UNAVAILABLE = Object.freeze({
  status: 410,
  code: "link_unavailable",
  message: "This link has expired, been cancelled, or reached its join limit. Ask for a new link.",
  httpPath: "POST /api/share-links/preview and POST /api/share-links/join",
  collapsedCauses: Object.freeze(["cancelled", "expired", "full", "authority_changed", "unknown_or_malformed_token"]),
  ui: "invitationFailureMessage surfaces error.message; incomplete hash says “This invitation link is incomplete. Ask for a new link.”",
  source: "server/share-links.mjs unavailable()"
});

export const DENIAL_CONTRACTS = Object.freeze({
  cancelled: Object.freeze({
    id: "cancelled",
    title: "Cancelled share link",
    status: LINK_UNAVAILABLE.status,
    code: LINK_UNAVAILABLE.code,
    message: LINK_UNAVAILABLE.message,
    local: "tests/share-links.test.js — cancel then preview/join throws link_unavailable; existing members remain",
    hosted: "gap"
  }),
  expired: Object.freeze({
    id: "expired",
    title: "Expired share link",
    status: LINK_UNAVAILABLE.status,
    code: LINK_UNAVAILABLE.code,
    message: LINK_UNAVAILABLE.message,
    local: "tests/share-links.test.js (clock to expiresAt) and tests/acceptance-fixture.test.js expired fixture",
    hosted: "gap"
  }),
  "join-cap": Object.freeze({
    id: "join-cap",
    title: "Join-cap / full share link",
    status: LINK_UNAVAILABLE.status,
    code: LINK_UNAVAILABLE.code,
    message: LINK_UNAVAILABLE.message,
    local: "tests/share-links.test.js maxJoins=2; third guest and preview throw link_unavailable; acceptance-fixture “full”",
    hosted: "gap"
  }),
  "removed-member": Object.freeze({
    id: "removed-member",
    title: "Removed member cannot use Room or recreate membership via the link",
    accountSession: Object.freeze({
      status: 403,
      code: "access_denied",
      message: "Active human Room membership required",
      httpPath: "GET /api/session?room=… or GET /api/rooms/:id with account session"
    }),
    roomCredential: Object.freeze({
      status: 401,
      code: "unauthenticated",
      message: "Session or key expired or revoked",
      note: "MEMBER_ACCESS_CHANGED active:false revokes room credentials first; authenticate then 401s before the inactive-membership 403"
    }),
    inactiveMembership: Object.freeze({
      status: 403,
      code: "access_denied",
      message: "Room membership is inactive"
    }),
    shareLinkReuse: Object.freeze({
      note: "share-links.join never recreates a removed membership when member_accounts still binds the account; result() then fails the inactive-membership check"
    }),
    local: "server/store.mjs authenticate / authenticateAccountSession; tests/service.test.js MEMBER_ACCESS_CHANGED; share-links.test.js comment “Never recreate a removed membership”",
    hosted: "gap"
  }),
  "signed-out-401": Object.freeze({
    id: "signed-out-401",
    title: "Signed-out Room read is 401",
    status: 401,
    code: "unauthenticated",
    messages: Object.freeze([
      "Browser session required",
      "Sign in with an active room key",
      "Session or key expired or revoked",
      "Account session expired, revoked, or account access ended"
    ]),
    httpPath: "GET /api/rooms/:id or GET /api/session after DELETE /api/session (signedOut: true)",
    local: "tests/invitation-http.test.js room cookie mismatch → 401 unauthenticated; store.mjs authenticate 401s",
    hosted: "operator-once — Codex reported signed-out room reads return 401 on staging; not a hosted-check.mjs case",
    logoutReceipt: Object.freeze({ status: 200, body: { signedOut: true } })
  }),
  "guest-session-ended": Object.freeze({
    id: "guest-session-ended",
    title: "Expired guest browser identity is not a recovery path",
    status: 409,
    code: "guest_session_ended",
    message: "Your previous browser identity expired. Sign out before joining as a new guest.",
    ui: "join dialog shows #join-link-signout only when error.code === guest_session_ended",
    local: "server/share-links.mjs; src/share-links.js",
    hosted: "gap"
  }),
  "guest-cannot-administer": Object.freeze({
    id: "guest-cannot-administer",
    title: "Guests cannot list or cancel invitation links",
    status: 403,
    code: "access_denied",
    message: "Only a human room administrator can manage invitation links",
    local: "tests/share-links.test.js",
    hosted: "gap"
  })
});

export const DENIAL_IDS = Object.freeze(Object.keys(DENIAL_CONTRACTS));
