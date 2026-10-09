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
  return ctx.json(ctx.res, 200, readSpendPricing(ctx.store, selected.token, roomId, fence));
}

export async function setSpendPricingRoute(ctx) {
  const { roomId, selected, fence } = context(ctx);
  const result = setSpendPricing(ctx.store, selected.token, roomId, await ctx.body(ctx.req), fence);
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

// Local row builder: same frozen shape/keys as the hand-written rows; keeps the table one row per line.
const row=(id,method,path,handler,schema)=>Object.freeze({id,method,path,auth:"room",capability:null,scope:"room",handler,schema,events:[]});

export const SPEND_PRICING_ROUTES = Object.freeze([
  // capability is null like every other route row: the dispatcher never reads
  // it, and the real gate is the owner check inside setSpendPricing. A
  // non-null value here would imply an enforcement that does not exist.
  row("get-spend-pricing", "GET", "/api/rooms/{roomId}/spend-pricing", getSpendPricing,
    { params: roomIdParam, response }),
  row("set-spend-pricing", "POST", "/api/rooms/{roomId}/spend-pricing", setSpendPricingRoute,
    { params: roomIdParam, body: pricingBody, response }),
]);
