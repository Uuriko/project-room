// Spend-pricing kill switch routes (jill-spend-pricing-killswitch).
// GET reads the room's pricing state (every member may read it); POST sets it
// (owner only, 403 for everyone else, checked in the module before parsing).
import { readSpendPricing, setSpendPricing } from "../spend-pricing.mjs";

function context(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  return { roomId, selected, fence };
}

export function getSpendPricing(ctx) {
  const { roomId, selected, fence } = context(ctx);
  const result = readSpendPricing(ctx.store, selected.token, roomId, fence);
  return ctx.json(ctx.res, 200, result);
}

export async function setSpendPricingRoute(ctx) {
  const { roomId, selected, fence } = context(ctx);
  const request = await ctx.body(ctx.req);
  const result = setSpendPricing(ctx.store, selected.token, roomId, request, fence);
  return ctx.json(ctx.res, result.duplicate ? 200 : 201, result);
}

const roomIdParam = Object.freeze({
  type: "object",
  required: ["roomId"],
  properties: { roomId: { type: "string" } },
});

const pricingBody = Object.freeze({
  type: "object",
  required: ["enabled"],
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    requestId: { type: "string" },
  },
});

const response = Object.freeze({ type: "object" });

export const SPEND_PRICING_ROUTES = Object.freeze([
  // capability is null like every other route row: the dispatcher never reads
  // it, and the real gate is the owner check inside setSpendPricing. A
  // non-null value here would imply an enforcement that does not exist.
  Object.freeze({ id: "get-spend-pricing", method: "GET", path: "/api/rooms/{roomId}/spend-pricing",
    auth: "room", capability: null, scope: "room", handler: getSpendPricing,
    schema: { params: roomIdParam, response }, events: [] }),
  Object.freeze({ id: "set-spend-pricing", method: "POST", path: "/api/rooms/{roomId}/spend-pricing",
    auth: "room", capability: null, scope: "room", handler: setSpendPricingRoute,
    schema: { params: roomIdParam, body: pricingBody, response }, events: [] }),
]);
