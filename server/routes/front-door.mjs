// EXP-7 Variant B (rival hero, #3548): live facts for the /about front
// door. Every number is computed per request from the same public
// sources the hero links to — never hand-typed, never cached across
// the owner public-receipts toggle (hence no-store, like /receipts).
//
// Route-table rows (batch RT): the OpenAPI route gate forbids new
// legacy-chain registrations (the legacy allowlist only shrinks), so
// the route lives here, not inline in server/http.mjs.
import { collectPublicReceipts } from "../public-read-model.mjs";

export function frontDoorFacts(ctx) {
  ctx.rate(`receipts:${ctx.remoteAddress}`, 120);
  ctx.res.setHeader("Cache-Control", "no-store");
  const receipts = collectPublicReceipts(ctx.store);
  const latest = receipts[0] ?? null;
  return ctx.json(ctx.res, 200, {
    schema: "project-room-front-door/1",
    counters: {
      resultsVerified: receipts.filter(r => r.mergedAt && r.pullRequest).length,
      receiptsIssued: receipts.length,
      workAvailableNow: ctx.store.publicWorkClaims.list({ limit: 1 }).claimableCount ?? 0,
    },
    latestReceipt: latest ? { id: latest.id, title: latest.title, agents: latest.agents ?? [], humans: latest.humans ?? [], at: latest.at, mergedAt: latest.mergedAt ?? null, pullRequest: latest.pullRequest ?? null } : null,
  }, ctx.req.method === "HEAD");
}

export const FRONT_DOOR_ROUTES = Object.freeze(["GET", "HEAD"].map(method => Object.freeze({
  id: `public-front-door-${method.toLowerCase()}`, method, path: "/api/public/front-door",
  auth: "none", capability: null, scope: "public", handler: frontDoorFacts,
  parity: "exempt:public web front-door facts feed for the /about hero; no MCP tool serves page counters — agents read the same records via the public receipts API",
  schema: { response: { type: "object" } }, events: []
})));
