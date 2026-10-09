// Squad roster routes (plan-squads, batch RT).
//
// The squad routes left the legacy chain in server/http.mjs: every new route
// must land in the route table (the legacy allowlist only shrinks).
//
// Auth mirrors the legacy squad chain exactly: room credential, fence,
// roomAuth, bearer/session checks, read+write rate limits, API-key
// rooms:read/rooms:write scopes. The dispatcher 405s wrong methods before
// these handlers run.

import { listSquads, getSquad, createSquad, updateSquadMembers, disbandSquad } from "../squads.mjs";

function squadContext(ctx, write) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer <redacted> sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (write) { ctx.protectWrite(ctx.req, auth, selected.bearer); ctx.rate(`write:${auth.credentialHash}`, 60); }
  if (auth.kind === "api-key") {
    const need = write ? "rooms:write" : "rooms:read";
    const ok = (auth.apiKeyScopes ?? []).some(s => s === need || (s.endsWith(":*") && need.startsWith(s.slice(0, -1))));
    if (!ok) ctx.reject(403, "insufficient_scope", `API key lacks the ${need} scope`);
  }
  return { roomId, selected, fence };
}

export async function listSquadsRoute(ctx) {
  const { roomId, selected, fence } = squadContext(ctx, false);
  return ctx.json(ctx.res, 200, listSquads(ctx.store, selected.token, roomId, fence));
}

export async function createSquadRoute(ctx) {
  const { roomId, selected, fence } = squadContext(ctx, true);
  const data = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 201, createSquad(ctx.store, selected.token, roomId, data, fence));
}

export async function getSquadRoute(ctx) {
  const { roomId, selected, fence } = squadContext(ctx, false);
  return ctx.json(ctx.res, 200, getSquad(ctx.store, selected.token, roomId, ctx.params.squadId, fence));
}

export async function updateSquadMembersRoute(ctx) {
  const { roomId, selected, fence } = squadContext(ctx, true);
  const data = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 200, updateSquadMembers(ctx.store, selected.token, roomId, ctx.params.squadId, data, fence));
}

export async function disbandSquadRoute(ctx) {
  const { roomId, selected, fence } = squadContext(ctx, true);
  return ctx.json(ctx.res, 200, disbandSquad(ctx.store, selected.token, roomId, ctx.params.squadId, fence));
}

const roomParameters = Object.freeze({ type: "object", required: ["roomId"],
  properties: { roomId: { type: "string" } } });
const squadParameters = Object.freeze({ type: "object", required: ["roomId", "squadId"],
  properties: { roomId: { type: "string" }, squadId: { type: "string" } } });
const squadBody = Object.freeze({ type: "object", required: ["name"],
  properties: {
    name: { type: "string" },
    goal: { type: "string" },
    channelMessageId: { type: "string" },
    memberIds: { type: "array" },
  } });
const membersBody = Object.freeze({ type: "object",
  properties: {
    add: { type: "array" },
    remove: { type: "array" },
  } });

const response = Object.freeze({ type: "object" });

// Local row builder: same frozen shape/keys as the hand-written rows; keeps the table one row per line.
const row=(id,method,path,handler,schema)=>Object.freeze({id,method,path,auth:"room",capability:null,scope:"room",handler,schema,events:[]});

export const SQUAD_ROUTES = Object.freeze([
  row("squads", "GET", "/api/rooms/{roomId}/squads", listSquadsRoute,
    { params: roomParameters, response }),
  row("squads-create", "POST", "/api/rooms/{roomId}/squads", createSquadRoute,
    { params: roomParameters, body: squadBody, response }),
  row("squad", "GET", "/api/rooms/{roomId}/squads/{squadId}", getSquadRoute,
    { params: squadParameters, response }),
  row("squad-members", "POST", "/api/rooms/{roomId}/squads/{squadId}/members", updateSquadMembersRoute,
    { params: squadParameters, body: membersBody, response }),
  row("squad-disband", "POST", "/api/rooms/{roomId}/squads/{squadId}/disband", disbandSquadRoute,
    { params: squadParameters, response }),
]);
