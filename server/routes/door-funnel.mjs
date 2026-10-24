// DOOR-FUNNEL-READ: GET /api/public/door-funnel — anonymous, counts-only
// weekly door aggregates (joins per public-directory-listed room, identity
// mints) computed by server/door-funnel.mjs from existing data only.
// Born in the route table: new routes join the table; the legacy allowlist
// only shrinks. Read-only: it mutates nothing, so the route carries no
// x-room-permission marker (that marker is for mutating operations).

import { readDoorFunnel } from "../door-funnel.mjs";

export function handleDoorFunnel(ctx) {
  ctx.rate(`door-funnel:${ctx.remoteAddress}`, 120);
  return ctx.json(ctx.res, 200, readDoorFunnel(ctx.store, {
    weeks: ctx.url.searchParams.get("weeks"),
  }));
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
