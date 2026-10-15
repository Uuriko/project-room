// Landing feed (#3548): one public GET behind the logged-out wall's hero —
// the live counters and the featured real receipt the front door renders.
// Born in the route table, like the sign-in options feed. The facts are
// built by server/landing-page.mjs, the same builder the server-rendered
// hero in index.html uses, so the JSON and the raw HTML can never drift.
// The response is no-store for the same reason the receipts routes are:
// the featured receipt is toggle-controlled, so a cached copy could keep
// showing a receipt after its owner switches receipts private.

import { buildLandingFeed } from "../landing-page.mjs";

export function handleLanding(ctx) {
  const { res, json, store } = ctx;
  res.setHeader("Cache-Control", "no-store");
  return json(res, 200, buildLandingFeed(store));
}

export const LANDING_ROUTES = Object.freeze([
  {
    id: "public.landing", method: "GET", path: "/api/public/landing", auth: "none",
    capability: null, events: [], scope: "public", handler: handleLanding,
    parity: "exempt:public landing feed (live counters + featured receipt) for the logged-out wall; agents read the same facts via /api/public/receipts and /api/public-work/tasks",
    schema: { response: { type: "object" } },
    rate: { key: "public-landing", max: 120 },
  },
]);
