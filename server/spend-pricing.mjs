// Spend-pricing kill switch: the owner-only emergency lever for the
// priced-tool gate (promised to Dot's QA lane, room seq 2748).
//
// The owner records { enabled: boolean } as a room event
// (room.spend_pricing_set); the projection carries it (src/events.js
// spendPricingEnabled, default enabled when absent). While disabled,
// server/spend-grants.mjs prices nothing: priceForTool(name, state) returns
// null for every tool, so chargeSpendBeforeCall returns null at the trust
// boundary — tools forward free, no grants are consulted, no rows are
// written. Re-enabling restores exact current behaviour. No new tables, no
// schema bump (event-sourced like server/spend-allowance.mjs).
//
// This module does not import server/store.mjs (store imports it); errors
// carry status and code like ServiceError and the router reads them as such.
import { randomUUID } from "node:crypto";
import { EVENT_TYPES as T, spendPricingEnabled, validId } from "../src/events.js";

export class SpendPricingError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new SpendPricingError(status, code, message); };

// GET /api/rooms/:id/spend-pricing - every member may read it: the enabled
// flag is a room-level setting members already see reflected in tool
// behaviour (priced tools either charge or forward free).
export function readSpendPricing(store, token, roomId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const stored = room.state.room.spendPricing ?? null;
    return {
      roomId,
      enabled: spendPricingEnabled(room.state),
      revision: stored?.revision ?? 0,
      setById: stored?.setById ?? null,
      setAt: stored?.setAt ?? null,
    };
  });
}

// POST /api/rooms/:id/spend-pricing - owner only (403 for everyone else,
// checked here before the request shape is parsed so a non-owner learns
// nothing about accepted fields from a malformed write). Body:
// { enabled: boolean, requestId? }.
export function setSpendPricing(store, token, roomId, request, expectedSessionBinding = null) {
  // Authenticate and authorize before parsing the request shape: a non-owner
  // learns nothing about accepted fields from a malformed write.
  store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    if (auth.member.id !== room.state.room.ownerId) refuse(403, "owner_required", "Only the room owner can set spend pricing");
  });
  if (!request || Array.isArray(request) || typeof request !== "object")
    refuse(422, "invalid_spend_pricing", "Supply { enabled } and an optional requestId");
  const keys = Object.keys(request);
  if (!keys.includes("enabled") || keys.some(key => !["enabled", "requestId"].includes(key)))
    refuse(422, "invalid_spend_pricing", "Supply enabled (boolean) and an optional requestId");
  if (typeof request.enabled !== "boolean")
    refuse(422, "invalid_spend_pricing", "enabled must be a boolean");
  if (request.requestId !== undefined && !validId(request.requestId))
    refuse(422, "invalid_spend_pricing", "requestId must be a valid identifier");
  return store.command(token, roomId, {
    id: request.requestId ?? randomUUID(),
    type: T.ROOM_SPEND_PRICING_SET,
    data: { enabled: request.enabled },
  }, expectedSessionBinding);
}
