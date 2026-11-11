// COMP-DEEP #1: GET /api/verdict-inbox. Born in the route table so the
// legacy allowlist does not grow. Two doors, one underlying set: a Bearer
// identity secret is the agent door; an account session is the human door.
// The handler enforces both. The auth column records the agent door.

import { collectVerdictInbox } from "../verdict-inbox-read.mjs";
import { identityRoomSeats } from "../membership-resolution.mjs";
import { isIdentitySecret } from "../agent-identities.mjs";
import { API_KEY_PREFIX } from "../agent-api-keys.mjs";
import { ROOM_TOKEN_NOT_IDENTITY } from "../agent-rooms.mjs";

export function handleVerdictInbox(ctx) {
  const { req, res, store, remoteAddress, rate, json, reject, bearer, cookie, accountBinding, accountCookieName } = ctx;
  rate(`verdict-inbox:${remoteAddress}`, 60);
  const secret = bearer(req);
  if (secret) {
    if (secret.startsWith(API_KEY_PREFIX)) reject(401, "room_token_not_identity", ROOM_TOKEN_NOT_IDENTITY);
    if (!isIdentitySecret(secret)) reject(401, "unauthenticated", "Identity secret required. Agents can self-mint an identity at POST /api/agent-identities.");
    const identity = store.identities.resolveGlobalIdentitySecret(secret);
    if (!identity) reject(401, "unauthenticated", "Unknown or revoked identity secret");
    const seats = identityRoomSeats(store.db, identity.identityId, { limit: 40 });
    const memberByRoom = new Map(seats.map(seat => [seat.roomId, seat.memberId]));
    return json(res, 200, collectVerdictInbox(store, { memberByRoom, surface: "agent", nowMs: Date.now() }));
  }
  const token = cookie(req, accountCookieName);
  const binding = accountBinding(req);
  const auth = store.authenticateAccountSession(token, null, binding);
  const memberByRoom = new Map();
  const roomRows = store.db.prepare(
    "SELECT room_id FROM member_accounts WHERE account_id=? ORDER BY room_id").all(auth.account.id);
  for (const { room_id: roomId } of roomRows.slice(0, 40)) {
    try {
      const roomAuth = store.authenticateAccountSession(token, roomId, binding);
      if (roomAuth.member && roomAuth.member.active !== false) memberByRoom.set(roomId, roomAuth.member.id);
    } catch (error) { if (error.status !== 403) throw error; }
  }
  return json(res, 200, collectVerdictInbox(store, { memberByRoom, surface: "human", nowMs: Date.now() }));
}

export const VERDICT_INBOX_ROUTES = Object.freeze([
  Object.freeze({
    id: "verdict-inbox",
    method: "GET",
    path: "/api/verdict-inbox",
    auth: "bearer",
    capability: null,
    scope: "worker",
    handler: handleVerdictInbox,
    parity: "exempt:dual-door verdict inbox; a bearer identity and an account session both read the same attention set, and no separate MCP name is registered",
    schema: { response: { type: "object" } },
    events: [],
  }),
]);
