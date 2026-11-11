// Code map routes. room_map is the read. Push and pull intake rebuild the
// map and are not a second tool.

import { enforceAutonomyTierForAction } from "../autonomy-tiers.mjs";
import { ownMember } from "../../src/events.js";
import { pushProjectMap, readProjectMap, recordProjectMapPull } from "../project-map-store.mjs";

function mapContext(ctx, write, { meter = true } = {}) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  if (meter) ctx.rate(`read:${auth.credentialHash}`, 600);
  if (write) {
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    if (meter) ctx.rate(`write:${auth.credentialHash}`, 60);
  }
  if (auth.kind === "api-key") {
    const requiredScope = write ? "rooms:write" : "rooms:read";
    const granted = (auth.apiKeyScopes ?? []).some(scope =>
      scope === requiredScope || (scope.endsWith(":*") && requiredScope.startsWith(scope.slice(0, -1))));
    if (!granted) ctx.reject(403, "insufficient_scope", `API key lacks the ${requiredScope} scope`);
  }
  if (write) {
    const state = ctx.store.room(roomId).state;
    const actor = ownMember(state.members, auth.member?.id);
    if (!actor || actor.active !== true) ctx.reject(403, "access_denied", "Active room membership required");
    enforceAutonomyTierForAction({ db: ctx.store.db, roomId, state, actor, action: "update the project map", fail: ctx.reject });
    if (actor.id !== state.room.ownerId && !(actor.permissions ?? []).some(permission => permission === "manage_claims" || permission === "steer"))
      ctx.reject(403, "access_denied", "Project map updates require room owner, manage_claims or steer authority");
  }
  return { roomId };
}

function repoOf(ctx) {
  return ctx.url.searchParams.get("repo") ?? undefined;
}

export async function queryMapRoute(ctx) {
  const { roomId } = mapContext(ctx, false);
  return ctx.json(ctx.res, 200, readProjectMap(ctx.store, roomId, { op: "query", q: ctx.url.searchParams.get("q") ?? "", repo: repoOf(ctx) }));
}

export async function pathMapRoute(ctx) {
  const { roomId } = mapContext(ctx, false);
  const from = ctx.url.searchParams.get("from") ?? "";
  const to = ctx.url.searchParams.get("to") ?? "";
  if (!from || !to) ctx.reject(422, "invalid_input", "from and to are required");
  return ctx.json(ctx.res, 200, readProjectMap(ctx.store, roomId, { op: "path", from, to, repo: repoOf(ctx) }));
}

export async function hotspotsMapRoute(ctx) {
  const { roomId } = mapContext(ctx, false);
  return ctx.json(ctx.res, 200, readProjectMap(ctx.store, roomId, { op: "hotspots", repo: repoOf(ctx) }));
}

export async function explainMapRoute(ctx) {
  const { roomId } = mapContext(ctx, false);
  return ctx.json(ctx.res, 200, readProjectMap(ctx.store, roomId, { op: "explain", q: ctx.url.searchParams.get("q") ?? "", repo: repoOf(ctx) }));
}

export async function pushMapRoute(ctx) {
  const { roomId } = mapContext(ctx, true);
  const data = await ctx.body(ctx.req, { limit: 1_500_000 });
  // Body reads yield; reauthenticate and recheck live policy before intake.
  mapContext(ctx, true, { meter: false });
  return ctx.json(ctx.res, 200, await pushProjectMap(ctx.store, roomId, data));
}

export async function recordPullRoute(ctx) {
  const { roomId } = mapContext(ctx, true);
  const data = await ctx.body(ctx.req, { limit: 262_144 });
  mapContext(ctx, true, { meter: false });
  return ctx.json(ctx.res, 200, recordProjectMapPull(ctx.store, roomId, data));
}

const roomParameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const queryParameters = Object.freeze({ type: "object", properties: { q: { type: "string" }, repo: { type: "string" } } });
const pathParameters = Object.freeze({ type: "object", properties: { from: { type: "string" }, to: { type: "string" }, repo: { type: "string" } } });
const repoQuery = Object.freeze({ type: "object", properties: { repo: { type: "string" } } });
const pushBody = Object.freeze({ type: "object", required: ["repo", "revision"], properties: {
  repo: { type: "string" }, revision: { type: "string" }, expectedRevision: { type: ["string", "null"] }, expectedGraphSha256: { type: ["string", "null"], description: "Previously read provenance.graphSha256; null when absent. Detects changed Graphify content at the same revision." }, replace: { type: "boolean" }, files: { type: "array" }, removed: { type: "array" }, graphify: { type: "object" }
} });
const pullBody = Object.freeze({ type: "object", required: ["repo", "number", "files"], properties: {
  repo: { type: "string" }, number: { type: "integer" }, title: { type: "string" }, state: { type: "string" }, files: { type: "array" }, claimId: { type: "string" }
} });

export const PROJECT_MAP_ROUTES = Object.freeze([
  Object.freeze({ id: "project-map-query", method: "GET", path: "/api/rooms/{roomId}/map/query",
    auth: "room", capability: null, scope: "room", handler: queryMapRoute, parity: "mcp:room_map",
    schema: { params: roomParameters, query: queryParameters, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "project-map-path", method: "GET", path: "/api/rooms/{roomId}/map/path",
    auth: "room", capability: null, scope: "room", handler: pathMapRoute, parity: "mcp:room_map",
    schema: { params: roomParameters, query: pathParameters, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "project-map-hotspots", method: "GET", path: "/api/rooms/{roomId}/map/hotspots",
    auth: "room", capability: null, scope: "room", handler: hotspotsMapRoute, parity: "mcp:room_map",
    schema: { params: roomParameters, query: repoQuery, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "project-map-explain", method: "GET", path: "/api/rooms/{roomId}/map/explain",
    auth: "room", capability: null, scope: "room", handler: explainMapRoute, parity: "mcp:room_map",
    schema: { params: roomParameters, query: queryParameters, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "project-map-push", method: "POST", path: "/api/rooms/{roomId}/map",
    auth: "room", capability: null, scope: "room", handler: pushMapRoute, parity: "exempt:map rebuild intake",
    bodyLimit: 1_500_000,
    schema: { params: roomParameters, body: pushBody, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "project-map-pulls", method: "POST", path: "/api/rooms/{roomId}/map/pulls",
    auth: "room", capability: null, scope: "room", handler: recordPullRoute, parity: "exempt:pull file intake",
    bodyLimit: 262_144,
    schema: { params: roomParameters, body: pullBody, response: { type: "object" } }, events: [] })
]);
