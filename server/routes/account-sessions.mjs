// Account-session inventory + targeted revocation (CX4).
//
// The native desktop sign-in retires its OAuth grant at redemption
// (server/routes/desktop-auth.mjs) and keeps only an account-session slot,
// so the OAuth session surface (GET /api/oauth/sessions, revoke-all) never
// sees the session the Mac app actually holds — and that endpoint is
// OAuth-only by design and stays that way. These two routes are the
// explicit account-session surface: any live account session may list the
// account's sessions and end exactly one of them. A revocation names one
// session id; sibling sessions — browser or native — are untouched, and an
// unknown, already-ended, or other-account id all answer the same 404.
//
// Handlers enforce their own authorization (the production dispatch does
// not set ctx.pipeline), mirroring the OAuth family's discipline:
// account cookie + session binding, and protectWrite (CSRF/origin) on the
// state-changing verb. The rows also carry `authenticate` so the
// dispatcher's wrong-method path runs the same session check before it
// answers 405 — anonymous callers get 401, never a method leak (SEC-03).

function requireAccountSession(ctx) {
  const { req, store, cookie, accountCookieName, accountBinding, reject } = ctx;
  const slotToken = cookie(req, accountCookieName);
  if (!slotToken) reject(401, "account_session_required", "Sign in to manage your sessions");
  try {
    return store.authenticateAccountSession(slotToken, null, accountBinding(req));
  } catch {
    reject(401, "account_session_required", "Sign in to manage your sessions");
  }
}

async function listAccountSessions(ctx) {
  const { res, store, rate, remoteAddress, json } = ctx;
  rate(`account-sessions-list:${remoteAddress}`, 60);
  const auth = requireAccountSession(ctx);
  return json(res, 200, { sessions: store.listAccountSessions(auth.account.id, auth.credentialHash) });
}

async function revokeAccountSession(ctx) {
  const { req, res, store, rate, remoteAddress, protectWrite, reject, json } = ctx;
  rate(`account-session-kill:${remoteAddress}`, 60);
  const auth = requireAccountSession(ctx);
  protectWrite(req, auth, false);
  if (!store.revokeAccountSession(auth.account.id, ctx.params.id)) {
    reject(404, "session_not_found", "No such active session");
  }
  return json(res, 200, { revoked: 1 });
}

export const ACCOUNT_SESSION_ROUTES = Object.freeze([
  Object.freeze({
    id: "account.sessions.list", method: "GET", path: "/api/account/sessions", auth: "account",
    capability: null, scope: "worker", events: [], rate: { key: "account-sessions-list", max: 60 },
    parity: "exempt:account-session inventory and targeted revocation are human account management; no MCP tool lists or revokes account login sessions",
    authenticate: requireAccountSession,
    handler: listAccountSessions, schema: { response: { type: "object" } },
  }),
  Object.freeze({
    id: "account.sessions.revoke", method: "DELETE", path: "/api/account/sessions/{id}", auth: "account",
    capability: null, scope: "worker", events: [], rate: { key: "account-session-kill", max: 60 },
    parity: "exempt:account-session inventory and targeted revocation are human account management; no MCP tool lists or revokes account login sessions",
    authenticate: requireAccountSession,
    handler: revokeAccountSession, schema: { params: { type: "object" }, response: { type: "object" } },
  }),
]);
