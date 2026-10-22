// Landing-record routes (RECORD-PRIM, mig-primitives.md Primitive 3).
//
// The room-native Record object: create / list / read / land / revoke /
// supersede a room-scoped landing record for a PR head. The state machine
// lives in server/landing-records.mjs over the durable registry in
// server/landing-record-sqlite.mjs; these handlers are the HTTP door,
// with the MCP tools (room_create_landing_record,
// room_list_landing_records, room_land_record,
// room_revoke_landing_record, room_supersede_landing_record) as the
// parity door.
//
// Auth mirrors the surface-claims route chain: room credential, fence,
// roomAuth, bearer/session checks, read/write rate limits, API-key
// rooms:read / rooms:write scopes, guest-agent write refusal.

import { landingRecordEnv, createLandingRecord, listLandingRecords, getLandingRecord, landLandingRecord, revokeLandingRecord, supersedeLandingRecord } from "../landing-records.mjs";
import { isGuestAgentMemberId } from "../guest-agent-links.mjs";

function requireRoomScope(ctx, auth, writing = false) {
  const required = writing ? "rooms:write" : "rooms:read";
  if (auth.kind !== "api-key") return;
  const granted = (auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*");
  if (!granted) ctx.reject(403, "insufficient_scope", `API key lacks the ${required} scope`);
}

function authenticate(ctx, writing = false) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") {
    ctx.reject(403, "access_denied", "Bearer <redacted> sessions are not accepted");
  }
  if (!selected.bearer && auth.kind !== "session") {
    ctx.reject(401, "unauthenticated", "Browser session required");
  }
  ctx.rate(`read:${auth.credentialHash}`, 600);
  requireRoomScope(ctx, auth, writing);
  if (writing) {
    if (isGuestAgentMemberId(auth.member.id)) ctx.reject(403, "guest_scope_denied", "Guest members cannot perform this action");
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    ctx.rate(`write:${auth.credentialHash}`, 60);
  }
  const members = ctx.store.roomAuthority(roomId).members ?? {};
  const member = members[auth.member.id];
  if (!member || member.active === false) {
    ctx.reject(403, "not_member", `Member "${auth.member.id}" is not a member of room "${roomId}"`);
  }
  return { roomId, auth };
}

export async function createLandingRecordRoute(ctx) {
  const { roomId, auth } = authenticate(ctx, true);
  const body = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 201, createLandingRecord(landingRecordEnv(ctx.store), roomId, auth.member.id, body ?? {}));
}

export async function listLandingRecordsRoute(ctx) {
  const { roomId, auth } = authenticate(ctx);
  const filter = {
    state: ctx.url.searchParams.get("state") ?? undefined,
    mine: ctx.url.searchParams.get("mine") === "1" || ctx.url.searchParams.get("mine") === "true",
  };
  const prParam = ctx.url.searchParams.get("pr");
  if (prParam !== null) filter.pr = Number(prParam);
  return ctx.json(ctx.res, 200, listLandingRecords(landingRecordEnv(ctx.store), roomId, auth.member.id, filter));
}

export async function getLandingRecordRoute(ctx) {
  const { roomId, auth } = authenticate(ctx);
  return ctx.json(ctx.res, 200, getLandingRecord(landingRecordEnv(ctx.store), roomId, auth.member.id, ctx.params.recordId));
}

export async function landLandingRecordRoute(ctx) {
  const { roomId, auth } = authenticate(ctx, true);
  const body = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 200, landLandingRecord(landingRecordEnv(ctx.store), roomId, auth.member.id, ctx.params.recordId, body ?? {}));
}

export async function revokeLandingRecordRoute(ctx) {
  const { roomId, auth } = authenticate(ctx, true);
  const body = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 200, revokeLandingRecord(landingRecordEnv(ctx.store), roomId, auth.member.id, ctx.params.recordId, body ?? {}));
}

export async function supersedeLandingRecordRoute(ctx) {
  const { roomId, auth } = authenticate(ctx, true);
  const body = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 200, supersedeLandingRecord(landingRecordEnv(ctx.store), roomId, auth.member.id, ctx.params.recordId, body ?? {}));
}

const roomParameters = Object.freeze({ type: "object", required: ["roomId"],
  properties: { roomId: { type: "string" } } });
const recordParameters = Object.freeze({ type: "object", required: ["roomId", "recordId"],
  properties: { roomId: { type: "string" }, recordId: { type: "string" } } });
const evidenceSchema = Object.freeze({ type: "array", items: { type: "object", properties: {
  kind: { type: "string" }, ref: { type: "string" }, label: { type: "string" }, headSha: { type: "string" } } } });
const flagsSchema = Object.freeze({ type: "array", items: { type: "object", properties: {
  flag: { type: "string" }, acceptingAuthority: { type: "string" } } } });
const createBody = Object.freeze({ type: "object", required: ["pr", "headSha", "baseSha"], properties: {
  pr: { type: "integer" }, headSha: { type: "string" }, baseSha: { type: "string" },
  evidence: evidenceSchema, flags: flagsSchema,
  acceptingAuthority: { type: "string" }, note: { type: "string" } } });
const landBody = Object.freeze({ type: "object", required: ["mergedSha"], properties: {
  mergedSha: { type: "string" }, treeSha: { type: "string" } } });
const revokeBody = Object.freeze({ type: "object", properties: { reason: { type: "string" } } });
const supersedeBody = Object.freeze({ type: "object", required: ["headSha"], properties: {
  headSha: { type: "string" }, note: { type: "string" } } });

export const LANDING_RECORD_ROUTES = Object.freeze([
  Object.freeze({ id: "landing-record-create", method: "POST", path: "/api/rooms/{roomId}/landing-records",
    auth: "room", capability: null, scope: "room", handler: createLandingRecordRoute,
    schema: { params: roomParameters, body: createBody, response: { type: "object" } }, events: [],
    parity: "mcp:room_create_landing_record" }),
  Object.freeze({ id: "landing-records-list", method: "GET", path: "/api/rooms/{roomId}/landing-records",
    auth: "room", capability: null, scope: "room", handler: listLandingRecordsRoute,
    schema: { params: roomParameters, response: { type: "object" } }, events: [],
    parity: "mcp:room_list_landing_records" }),
  Object.freeze({ id: "landing-record-read", method: "GET", path: "/api/rooms/{roomId}/landing-records/{recordId}",
    auth: "room", capability: null, scope: "room", handler: getLandingRecordRoute,
    schema: { params: recordParameters, response: { type: "object" } }, events: [],
    parity: "mcp:room_list_landing_records" }),
  Object.freeze({ id: "landing-record-land", method: "POST", path: "/api/rooms/{roomId}/landing-records/{recordId}/land",
    auth: "room", capability: null, scope: "room", handler: landLandingRecordRoute,
    schema: { params: recordParameters, body: landBody, response: { type: "object" } }, events: [],
    parity: "mcp:room_land_record" }),
  Object.freeze({ id: "landing-record-revoke", method: "POST", path: "/api/rooms/{roomId}/landing-records/{recordId}/revoke",
    auth: "room", capability: null, scope: "room", handler: revokeLandingRecordRoute,
    schema: { params: recordParameters, body: revokeBody, response: { type: "object" } }, events: [],
    parity: "mcp:room_revoke_landing_record" }),
  Object.freeze({ id: "landing-record-supersede", method: "POST", path: "/api/rooms/{roomId}/landing-records/{recordId}/supersede",
    auth: "room", capability: null, scope: "room", handler: supersedeLandingRecordRoute,
    schema: { params: recordParameters, body: supersedeBody, response: { type: "object" } }, events: [],
    parity: "mcp:room_supersede_landing_record" }),
]);
