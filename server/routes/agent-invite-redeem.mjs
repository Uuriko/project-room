// Agent invite codes: redemption is unauthenticated (the code is the
// bearer credential); issuance is owner-only per room. GET is a fallback for
// an agent that can only fetch a URL: it reports whether the code can still
// be redeemed and never returns the code.
import { validId } from "../../src/events.js";
import { diagnoseArguments } from "../mcp-arg-errors.mjs";

const object = { type: "object" };

async function redeemInvite(ctx) {
  ctx.rate(`invite-redeem:${ctx.remoteAddress}`, 20);
  const data = await ctx.body(ctx.req);
  // Colony round-2 (musespark-explorer, 2026-10-06): the static 422 here
  // blamed the caller for sending *less* when the body carried an *extra*
  // field — a recovery trap for a cold client. Port the access-request
  // diagnoseArguments pattern so the 422 names the offending field.
  const diagnosis = diagnoseArguments({
    required: ["code", "displayName"],
    properties: { code: { type: "string" }, displayName: { type: "string" }, requestId: { type: "string" } },
    additionalProperties: false,
  }, data);
  if (diagnosis) {
    const parts = [];
    if (diagnosis.missing.length) parts.push(`missing required field${diagnosis.missing.length > 1 ? "s" : ""}: ${diagnosis.missing.join(", ")}`);
    if (diagnosis.unexpected.length) parts.push(`unexpected field${diagnosis.unexpected.length > 1 ? "s" : ""}: ${diagnosis.unexpected.join(", ")}`);
    for (const [field, reason] of Object.entries(diagnosis.invalid)) parts.push(`${field}: ${reason}`);
    ctx.reject(422, "invalid_invite", `Invalid invite redeem (${parts.join("; ")}). Send exactly {code, displayName} with an optional requestId.`);
  }
  // G1 idempotent redeem (PRODUCT-200 D7): an opt-in client-kept
  // requestId makes an uncertain retry safe — the retry replays the
  // journaled redemption instead of 409ing on the burned code.
  let requestId = null;
  if (data.requestId !== undefined) {
    if (!validId(data.requestId)) ctx.reject(422, "invalid_invite", "Send a valid request id for retry-safe redemption.");
    requestId = data.requestId;
  }
  const redeemedInvite = ctx.store.invites.redeem(data.code, { displayName: data.displayName, identitySecret: ctx.bearer(ctx.req), requestId });
  // Jev-harness admission gate, shadow mode (docs/JEV-GATES.md):
  // score the join, journal the would-be decision, admit anyway.
  ctx.jevShadowAdmission("agent-invite:redeem", { roomId: redeemedInvite.roomId, identityId: redeemedInvite.identityId,
    displayName: redeemedInvite.displayName ?? data.displayName, card: null });
  return ctx.json(ctx.res, 201, redeemedInvite);
}

function inviteAvailability(ctx) {
  ctx.rate(`invite-redeem:${ctx.remoteAddress}`, 20);
  return ctx.json(ctx.res, 200, ctx.store.invites.availability(ctx.url.searchParams.get("code") ?? ""));
}

export const AGENT_INVITE_REDEEM_ROUTES = Object.freeze([
  Object.freeze({ id: "agent-invite-redeem", method: "POST", path: "/api/agent-invites/redeem", auth: "none", capability: null, scope: "public", handler: redeemInvite, parity: "exempt:invite code redemption", schema: { body: object, response: object }, events: ["member.added"] }),
  Object.freeze({ id: "agent-invite-availability", method: "GET", path: "/api/agent-invites/redeem", auth: "none", capability: null, scope: "public", handler: inviteAvailability, parity: "exempt:fetch-only invite availability", schema: { query: object, response: object }, events: [] })
]);
