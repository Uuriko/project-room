// Join profile over HTTP. POST /api/agent-invites/redeem is intercepted
// here so an optional profile can be validated without editing http.mjs.
// GET and PATCH are the agent itself or the room owner.

import { diagnoseArguments } from "../mcp-arg-errors.mjs";
import { isGuestAgentMemberId } from "../guest-agent-links.mjs";
import { enforceAutonomyTierForAction } from "../autonomy-tiers.mjs";
import { isRoomArchived, ownMember } from "../../src/events.js";
import {
  checkedJoinProfile,
  journalAgentInviteAdmission,
  profileBody,
  redeemInviteWithProfile,
  setMemberJoinProfile,
  throwJoinProfile,
  validRedeemRequestId,
} from "../agent-join-profile.mjs";

function authenticate(ctx, writing) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (auth.kind === "api-key") {
    const required = writing ? "rooms:write" : "rooms:read";
    if (!(auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*")) {
      ctx.reject(403, "insufficient_scope", `API key lacks the ${required} scope`);
    }
  }
  if (writing) {
    if (isGuestAgentMemberId(auth.member.id)) ctx.reject(403, "guest_scope_denied", "Guest members cannot perform this action");
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    ctx.rate(`write:${auth.credentialHash}`, 60);
    enforceAutonomyTierForAction({
      db: ctx.store.db, roomId, state: ctx.store.room(roomId).state, actor: auth.member, action: "change a join profile",
    });
  }
  return { roomId, auth };
}

function targetMember(ctx, roomId, memberId) {
  const state = ctx.store.room(roomId).state;
  const member = ownMember(state.members, memberId);
  if (!member) ctx.reject(404, "unknown_member", "No such member");
  if (member.active === false) ctx.reject(403, "access_ended", "Membership is no longer active");
  return { state, member };
}

function authorizeProfile(ctx, auth, state, memberId) {
  if (auth.member.id === memberId || auth.member.id === state.room.ownerId) return;
  throwJoinProfile({
    code: "join_profile_forbidden",
    message: "Only this member or the room owner can read or change this join profile.",
    next: "Retry as this member or the room owner.",
  });
}

export function readMemberProfile(ctx) {
  const { roomId, auth } = authenticate(ctx, false);
  const { state, member } = targetMember(ctx, roomId, ctx.params.memberId);
  authorizeProfile(ctx, auth, state, member.id);
  if (member.kind !== "agent") {
    throwJoinProfile({
      code: "join_profile_invalid",
      message: "Join profiles are for agent members.",
      next: "Read the member roster. Join profiles belong to agent members.",
    });
  }
  return ctx.json(ctx.res, 200, profileBody(roomId, member.id, member));
}

export async function patchMemberProfile(ctx) {
  const { roomId, auth } = authenticate(ctx, true);
  const { state, member } = targetMember(ctx, roomId, ctx.params.memberId);
  authorizeProfile(ctx, auth, state, member.id);
  if (isRoomArchived(state)) ctx.reject(409, "room_archived", "This room is archived");
  const data = await ctx.body(ctx.req);
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.hasOwn(data, "profile")) {
    throwJoinProfile({
      code: "join_profile_invalid",
      message: "Send profile with the fields to change.",
      next: "Send { profile: { wake, events, maxClaims, roles, detail, or capabilities } }.",
    });
  }
  const extra = Object.keys(data).find(key => key !== "profile");
  if (extra) {
    throwJoinProfile({
      code: "join_profile_invalid",
      message: `Remove unknown field ${extra}. Send profile only.`,
      next: "Send { profile: { wake, events, maxClaims, roles, detail, or capabilities } }.",
    });
  }
  const partial = checkedJoinProfile(data.profile, { partial: true });
  const actorId = auth.member.id;
  const saved = ctx.store.transaction(() => setMemberJoinProfile(ctx.store, roomId, {
    actorId, memberId: member.id, partial,
  }));
  return ctx.json(ctx.res, 200, profileBody(roomId, member.id, saved.member, saved.unchanged ? { unchanged: true } : {}));
}

export async function redeemAgentInvite(ctx) {
  ctx.rate(`invite-redeem:${ctx.remoteAddress}`, 20);
  const data = await ctx.body(ctx.req);
  if (data && typeof data === "object" && !Array.isArray(data) && Object.hasOwn(data, "profile") && data.profile === null) {
    throwJoinProfile({ code: "join_profile_invalid", reason: "type" });
  }
  const diagnosis = diagnoseArguments({
    required: ["code"],
    properties: {
      code: { type: "string" },
      displayName: { type: "string" },
      requestId: { type: "string" },
      profile: {},
    },
    additionalProperties: false,
  }, data);
  if (diagnosis) {
    const parts = [];
    if (diagnosis.missing.length) parts.push(`missing required field${diagnosis.missing.length > 1 ? "s" : ""}: ${diagnosis.missing.join(", ")}`);
    if (diagnosis.unexpected.length) parts.push(`unexpected field${diagnosis.unexpected.length > 1 ? "s" : ""}: ${diagnosis.unexpected.join(", ")}`);
    for (const [field, reason] of Object.entries(diagnosis.invalid)) parts.push(`${field}: ${reason}`);
    ctx.reject(422, "invalid_invite", `Invalid invite redeem (${parts.join("; ")}). Send {code} with an optional displayName, an optional requestId, and an optional profile. displayName is optional for an existing identity.`);
  }
  let requestId = null;
  if (data.requestId !== undefined) {
    if (!validRedeemRequestId(data.requestId)) ctx.reject(422, "invalid_invite", "Send a valid request id for retry-safe redemption.");
    requestId = data.requestId;
  }
  const redeemed = redeemInviteWithProfile(ctx.store, data.code, {
    displayName: data.displayName,
    identitySecret: ctx.bearer(ctx.req),
    requestId,
  }, data.profile);
  journalAgentInviteAdmission(ctx.store, ctx.remoteAddress, {
    roomId: redeemed.roomId,
    identityId: redeemed.identityId,
    displayName: redeemed.displayName ?? data.displayName,
  });
  return ctx.json(ctx.res, 201, redeemed);
}

const parameters = Object.freeze({
  type: "object",
  required: ["roomId", "memberId"],
  properties: { roomId: { type: "string" }, memberId: { type: "string" } },
});
const profileSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    wake: { type: "string" },
    events: { type: "string" },
    maxClaims: { type: "integer" },
    roles: { type: "array" },
    detail: { type: "string" },
    capabilities: { type: "array" },
  },
});
const PATH = "/api/rooms/{roomId}/members/{memberId}/profile";

export const AGENT_JOIN_PROFILE_ROUTES = Object.freeze([
  Object.freeze({
    id: "redeem-agent-invite", method: "POST", path: "/api/agent-invites/redeem",
    auth: "none", capability: null, scope: "public", handler: redeemAgentInvite,
    schema: {
      body: {
        type: "object", additionalProperties: false, required: ["code"],
        properties: {
          code: { type: "string" }, displayName: { type: "string" }, requestId: { type: "string" }, profile: { type: "object" },
        },
      },
      response: { type: "object" },
    },
    events: ["member.added", "member.profile_set"],
    parity: "mcp:room_join",
  }),
  Object.freeze({
    id: "read-member-join-profile", method: "GET", path: PATH,
    auth: "room", capability: null, scope: "room", handler: readMemberProfile,
    schema: { params: parameters, response: { type: "object" } },
    events: [], parity: "mcp:room_member_profile",
  }),
  Object.freeze({
    id: "patch-member-join-profile", method: "PATCH", path: PATH,
    auth: "room", capability: null, scope: "room", handler: patchMemberProfile,
    schema: {
      params: parameters,
      body: { type: "object", additionalProperties: false, properties: { profile: profileSchema } },
      response: { type: "object" },
    },
    events: ["member.profile_set"], parity: "mcp:room_member_profile",
  }),
]);
