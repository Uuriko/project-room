// EXP-7 Variant B (rival hero, #3548): live facts for the /about front
// door. Every number is computed per request from the same public
// sources the hero links to — never hand-typed, never cached across
// the owner public-receipts toggle (hence no-store, like /receipts).
//
// Route-table rows (batch RT): the OpenAPI route gate forbids new
// legacy-chain registrations (the legacy allowlist only shrinks), so
// the route lives here, not inline in server/http.mjs.
import { collectPublicReceipts } from "../receipts-live.mjs";

// The featured exemplar is the front door's strongest claim, so it is
// held to a stronger rule than the wall (PROOF-WALL-FLIP): only a
// receipt carrying a verification beyond the worker's own report may
// be featured — a server-verified merge, a member-verified completion
// (a distinct member recorded the verdict), or a public-work receipt
// stamped verified / system_checked, or carrying a reviewer's PASS.
// A self-attested or hash-only receipt stays on the wall at its true
// tier; it is never the exemplar. With no eligible receipt the card
// shows the honest empty state (latestReceipt: null).
export function exemplarEligible(receipt) {
  if (!receipt || typeof receipt !== "object") return false;
  if (receipt.mergedAt && receipt.pullRequest) return true;
  if (receipt.verification && typeof receipt.verification === "object"
    && receipt.verification.state === "verified") return true;
  if (receipt.source === "public-work") {
    if (receipt.state === "verified" || receipt.verification === "system_checked") return true;
    if (receipt.review && receipt.review.verificationVerdict === "PASS") return true;
  }
  return false;
}

export function frontDoorFacts(ctx) {
  ctx.rate(`receipts:${ctx.remoteAddress}`, 120);
  ctx.res.setHeader("Cache-Control", "no-store");
  const receipts = collectPublicReceipts(ctx.store);
  const latest = receipts.find(exemplarEligible) ?? null;
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
