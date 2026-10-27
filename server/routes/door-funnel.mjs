// DOOR-FUNNEL-READ: GET /api/public/door-funnel — anonymous, counts-only
// weekly door aggregates (joins per public-directory-listed room, identity
// mints) computed by server/door-funnel.mjs from existing data only.
// Born in the route table: new routes join the table; the legacy allowlist
// only shrinks. Read-only: it mutates nothing, so the route carries no
// x-room-permission marker (that marker is for mutating operations).

import { readDoorFunnel } from "../door-funnel.mjs";

export const DOOR_FUNNEL_PUBLIC_CACHE = "public, max-age=600";

function header(req, name) {
  const headers = req?.headers;
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function ownerIdOf(store, roomId) {
  if (typeof store.roomAuthority === "function") return store.roomAuthority(roomId).ownerId;
  return store.room(roomId).state.room.ownerId;
}

function authIsRoomOwner(store, auth) {
  return Boolean(auth?.roomId && auth.member?.id && ownerIdOf(store, auth.roomId) === auth.member.id);
}

// Anonymous and non-owner callers get the public aggregate. A room access
// token or account session whose member is that room's owner gets mint counts.
// A missing or rejected credential stays on the public read; a malformed
// Authorization header still rejects, the same as every other route that
// parses Bearer.
function callerIsOwner(ctx) {
  const store = ctx.store;
  if (!store || typeof store.authenticate !== "function" || !ctx.req) return false;
  if (header(ctx.req, "authorization")) {
    const token = typeof ctx.bearer === "function" ? ctx.bearer(ctx.req) : null;
    if (!token) return false;
    try {
      return authIsRoomOwner(store, store.authenticate(token));
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) return false;
      throw error;
    }
  }
  if (typeof ctx.cookie !== "function" || !ctx.accountCookieName) return false;
  const slot = ctx.cookie(ctx.req, ctx.accountCookieName);
  if (!slot || typeof store.authenticateAccountSession !== "function" || !store.db?.prepare) return false;
  try {
    const auth = store.authenticateAccountSession(slot, null, null);
    const rows = store.db.prepare(
      "SELECT room_id AS roomId, member_id AS memberId FROM member_accounts WHERE account_id=?",
    ).all(auth.account.id);
    return rows.some(row => ownerIdOf(store, row.roomId) === row.memberId);
  } catch (error) {
    if (error?.status === 401 || error?.status === 403 || error?.status === 409 || error?.status === 422) return false;
    throw error;
  }
}

export function handleDoorFunnel(ctx) {
  ctx.rate(`door-funnel:${ctx.remoteAddress}`, 120);
  const owner = callerIsOwner(ctx);
  const body = readDoorFunnel(ctx.store, {
    weeks: ctx.url.searchParams.get("weeks"),
    includeMints: owner,
  });
  ctx.res.setHeader("Cache-Control", owner ? "private, no-store" : DOOR_FUNNEL_PUBLIC_CACHE);
  if (owner) ctx.res.setHeader("Vary", "Authorization, Cookie");
  return ctx.json(ctx.res, 200, body);
}

const query = Object.freeze({ type: "object",
  properties: {
    weeks: { type: "string", description: "Weeks of history to return, clamped to 1..12 (default 12)" },
  } });

export const DOOR_FUNNEL_ROUTES = Object.freeze([
  Object.freeze({ id: "public.door-funnel", method: "GET", path: "/api/public/door-funnel",
    auth: "none", capability: null, scope: "public", handler: handleDoorFunnel,
    parity: "exempt:measurement-surface",
    schema: { query, response: { type: "object" } },
    events: [] }),
]);
