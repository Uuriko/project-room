// Cost preview: what a priced action will cost before it runs.
// POST /api/rooms/{roomId}/spend-preview { tool } -> price, what the caller's
// own cap and the shared room budget would have left, and whether the
// charge gate would refuse it. Nothing is reserved or charged.
// Per-member caps inside the shared budget are the existing per-agent spend
// grants under the room allowance; this read shows both at once.
import { priceForTool, spendGrantSummary } from "../spend-grants.mjs";
import { spendAllowanceReport } from "../spend-allowance.mjs";

const dollars = cents => `$${(cents / 100).toFixed(2)}`;

function access(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  return { roomId, auth };
}

export function previewSpend(store, roomId, memberId, tool, nowMs = store.now()) {
  const room = store.room(roomId);
  const price = priceForTool(tool, room.state);
  if (room.state.room.ownerId === memberId || price === null) {
    return { tool, priceCents: 0, label: "Free", owner: room.state.room.ownerId === memberId, wouldRefuse: false, reason: null, member: null, room: null };
  }
  const grant = spendGrantSummary(store.db, roomId, memberId, { nowMs });
  const report = spendAllowanceReport(room.state, nowMs);
  const memberLeft = grant ? Number(grant.remainingCents) : 0;
  const roomLeft = report.allowance ? report.headroomCents : null;
  let reason = null;
  if (!grant) reason = "no_spend_grant";
  else if (grant.allowlist && !grant.allowlist.includes(tool)) reason = "tool_not_allowlisted";
  else if (price > Number(grant.perTxCapCents)) reason = "over_per_call_cap";
  else if (price > memberLeft) reason = "member_cap_reached";
  else if (roomLeft !== null && price > roomLeft) reason = "room_budget_reached";
  return { tool, priceCents: price, label: `Costs ${dollars(price)}`, owner: false, wouldRefuse: reason !== null, reason,
    member: grant ? { capCents: Number(grant.capCents), leftCents: memberLeft, leftAfterCents: Math.max(0, memberLeft - price) } : null,
    room: roomLeft === null ? null : { allowanceCents: report.allowance.allowanceCents, leftCents: roomLeft, leftAfterCents: Math.max(0, roomLeft - price) } };
}

export async function readSpendPreview(ctx) {
  const { roomId, auth } = access(ctx);
  const data = await ctx.body(ctx.req);
  if (typeof data?.tool !== "string" || !/^[a-z_]{1,64}$/.test(data.tool))
    ctx.reject(422, "invalid_spend_preview", "tool is a tool name such as room_put_file");
  return ctx.json(ctx.res, 200, { roomId, memberId: auth.member.id, ...ctx.store.readTransaction(() => previewSpend(ctx.store, roomId, auth.member.id, data.tool)) });
}

export const SPEND_PREVIEW_ROUTES = Object.freeze([
  Object.freeze({ id: "spend-preview", method: "POST", path: "/api/rooms/{roomId}/spend-preview", auth: "room", capability: null, scope: "room",
    handler: readSpendPreview, parity: "exempt:HTTP-first read; an MCP preview flag follows once #4339 lands",
    schema: { params: Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } }), response: Object.freeze({ type: "object" }) }, events: [] }),
]);
