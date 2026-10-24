// DECLARE (MIG-PRESENCE Gap 2): POST /api/rooms/{roomId}/route-request —
// route a work action to a named seat and get a typed answer, never a
// silent drop.
//
// The body names a member and an action ("execute" | "review" |
// "observe"). An agent seat's execution declaration (declared on the
// heartbeat payload, see server/agent-heartbeats.mjs) gates the action:
//   - the declaration includes the action -> routed: the request is queued
//     as an "assignment" wake signal under its request id and the caller
//     gets a route_accepted receipt;
//   - the declaration excludes the action -> a route_decline receipt with
//     reason "wrong_seat", naming the declared capabilities and scope —
//     the seat's answer travels back to the sender (Codex review seat,
//     room seq 17376: a request routed to the wrong seat is declined BY
//     that seat, not silently dropped);
//   - the seat never declared -> route_decline with reason
//     "execution_not_declared" (an absent declaration means none declared,
//     never an implied all-actions grant).
// Human members carry no execution declaration and accept directly
// (receipt via "human_member", no wake signal — humans have their own
// notification paths). Membership is the permission floor: the caller
// must be a member of the room and the target an active member; the
// declaration is AND-ed on top, it never elevates a non-member into
// reachability. No new identity, no new task engine: the accepted request
// rides the existing wake queue and the receipt is the answer.

import { randomBytes } from "node:crypto";
import { isRoomArchived, ownMember } from "../../src/events.js";
import { EXECUTION_CAPABILITIES } from "../agent-heartbeats.mjs";

const MAX_NOTE_CHARS = 1000;
const BODY_KEYS = Object.freeze(["memberId", "action", "note"]);

function context(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer <redacted> sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  ctx.protectWrite(ctx.req, auth, selected.bearer);
  ctx.rate(`write:${auth.credentialHash}`, 60);
  if (auth.kind === "api-key") {
    if (!(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:write" || scope === "rooms:*")) {
      ctx.reject(403, "insufficient_scope", "API key lacks rooms:write");
    }
  }
  return { roomId, auth };
}

const newRequestId = () => `rr_${randomBytes(9).toString("base64url")}`;

export async function routeRequest(ctx) {
  const { roomId, auth } = context(ctx);
  let state = null;
  try { state = ctx.store.room?.(roomId)?.state ?? null; } catch { state = null; }
  if (isRoomArchived(state)) ctx.reject(409, "room_archived", "This room is archived");
  const data = await ctx.body(ctx.req);
  if (!data || typeof data !== "object" || Array.isArray(data)
      || !Object.keys(data).every(key => BODY_KEYS.includes(key))
      || typeof data.memberId !== "string" || data.memberId.length === 0
      || !EXECUTION_CAPABILITIES.includes(data.action)
      || (data.note !== undefined && data.note !== null
        && (typeof data.note !== "string" || data.note.length > MAX_NOTE_CHARS)))
    ctx.reject(422, "invalid_request",
      `memberId (a member of this room) and action (one of ${EXECUTION_CAPABILITIES.join(", ")}) are required; note is an optional string of at most ${MAX_NOTE_CHARS} chars`);
  const { members } = ctx.store.roomAuthority(roomId);
  const target = ownMember(members, data.memberId);
  if (!target || target.active === false)
    ctx.reject(404, "member_not_found", `No member ${data.memberId} in this room`);
  const base = { roomId, memberId: target.id, action: data.action, requestedBy: auth.member.id };
  if (target.kind !== "agent") {
    return ctx.json(ctx.res, 200, { routed: true,
      receipt: Object.freeze({ kind: "route_accepted", ...base, via: "human_member", requestId: newRequestId() }) });
  }
  const link = ctx.store.db.prepare(
    "SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?").get(roomId, target.id);
  const identityId = link?.identityId ?? target.identityId ?? null;
  const execution = identityId ? ctx.store.agentHeartbeats.declarationOf(identityId).execution : null;
  if (!execution) {
    return ctx.json(ctx.res, 200, { routed: false,
      receipt: Object.freeze({ kind: "route_decline", reason: "execution_not_declared", ...base,
        identityId, declaredCapabilities: null, declaredScope: null }) });
  }
  if (!execution.capabilities.includes(data.action)) {
    return ctx.json(ctx.res, 200, { routed: false,
      receipt: Object.freeze({ kind: "route_decline", reason: "wrong_seat", ...base,
        identityId, declaredCapabilities: execution.capabilities, declaredScope: execution.scope ?? null }) });
  }
  const requestId = newRequestId();
  const { enqueued } = ctx.store.agentHeartbeats.enqueueWake(
    { agentId: identityId, kind: "assignment", roomId, messageId: requestId });
  return ctx.json(ctx.res, 200, { routed: true,
    receipt: Object.freeze({ kind: "route_accepted", ...base, identityId, requestId, enqueued }) });
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const PATH = "/api/rooms/{roomId}/route-request";

export const ROUTE_REQUEST_ROUTES = Object.freeze([
  Object.freeze({ id: "route-request", method: "POST", path: PATH,
    auth: "room", capability: null, scope: "room", handler: routeRequest,
    parity: "exempt:no MCP tool routes a work action to a named seat; routing with a typed decline receipt is an HTTP-door coordination act (DECLARE, MIG-PRESENCE Gap 2)",
    schema: { params: parameters,
      body: { type: "object", additionalProperties: false, required: ["memberId", "action"],
        properties: { memberId: { type: "string" }, action: { type: "string" }, note: { type: "string" } } },
      response: { type: "object" } },
    events: [] }),
]);
