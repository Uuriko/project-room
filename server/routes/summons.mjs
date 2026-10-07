// The Summons (server/summons.mjs): standing public calls for capabilities
// the room needs. Any member may post one; any other member may answer;
// the summoner (or manage_members) may withdraw. Issuing calls the members
// whose advertised capabilities already match; answering appends the
// public summons.answered celebration.

import { EVENT_TYPES, isRoomArchived, memberCan } from "../../src/events.js";
import { appendRoomEvent } from "../receipt-cards.mjs";
import {
  SummonsInputError,
  answerSummons,
  createSummons,
  getSummons,
  listSummons,
  noteSummonsIssued,
  withdrawSummons,
} from "../summons.mjs";

function context(ctx, write) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  if (!auth.member || auth.member.active === false) ctx.reject(403, "access_denied", "Membership is not active");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (write) {
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    ctx.rate(`write:${auth.credentialHash}`, 60);
  }
  if (auth.kind === "api-key") {
    const required = write ? "rooms:write" : "rooms:read";
    if (!(auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*")) {
      ctx.reject(403, "insufficient_scope", `API key lacks ${required}`);
    }
  }
  return { roomId, auth };
}

function refuseArchived(ctx, roomId) {
  let state = null;
  try { state = ctx.store.room?.(roomId)?.state ?? null; } catch { state = null; }
  if (isRoomArchived(state)) ctx.reject(409, "room_archived", "This room is archived");
}

const nowOf = store => (typeof store.now === "function" ? store.now() : Date.now());

const displayNameOf = (store, roomId, memberId) => {
  try {
    const member = store.room(roomId)?.state?.members?.[memberId];
    const name = member?.displayName;
    return typeof name === "string" && name.trim() ? name.trim() : memberId;
  } catch {
    return memberId;
  }
};

export async function createSummonsRoute(ctx) {
  const { roomId, auth } = context(ctx, true);
  refuseArchived(ctx, roomId);
  const data = await ctx.body(ctx.req);
  let summons;
  try {
    summons = createSummons(ctx.store.db, roomId, data, { byMemberId: auth.member.id, now: nowOf(ctx.store) });
  } catch (error) {
    if (error instanceof SummonsInputError) ctx.reject(422, "invalid_request", error.message);
    throw error;
  }
  appendRoomEvent(ctx.store, roomId, {
    id: `summons-issued-${summons.id}`,
    type: EVENT_TYPES.SUMMONS_ISSUED,
    actorId: auth.member.id,
    atMs: nowOf(ctx.store),
    data: {
      summonsId: summons.id,
      labels: summons.labels,
      note: summons.note,
      summonerDisplayName: displayNameOf(ctx.store, roomId, auth.member.id),
    },
  });
  // Best-effort fanfare: the summons stands even if the calls fail.
  try {
    noteSummonsIssued(ctx.store, roomId, summons, { now: nowOf(ctx.store) });
  } catch (error) {
    console.error("summons issued calls failed:", error?.message ?? error);
  }
  return ctx.json(ctx.res, 201, summons);
}

export function listSummonsRoute(ctx) {
  const { roomId } = context(ctx, false);
  const status = ctx.url.searchParams.get("status") ?? "open";
  if (!["open", "answered", "withdrawn", "all"].includes(status)) {
    ctx.reject(422, "invalid_summons_status", "status is one of open, answered, withdrawn, all");
  }
  return ctx.json(ctx.res, 200, { roomId, status, summons: listSummons(ctx.store.db, roomId, { status }) });
}

export async function answerSummonsRoute(ctx) {
  const { roomId, auth } = context(ctx, true);
  refuseArchived(ctx, roomId);
  const summonsId = ctx.params.summonsId;
  if (!getSummons(ctx.store.db, roomId, summonsId)) ctx.reject(404, "summons_not_found", "No such summons in this room");
  let answered;
  try {
    answered = answerSummons(ctx.store.db, roomId, summonsId, { byMemberId: auth.member.id, now: nowOf(ctx.store) });
  } catch (error) {
    if (error instanceof SummonsInputError) ctx.reject(422, "invalid_request", error.message);
    throw error;
  }
  appendRoomEvent(ctx.store, roomId, {
    id: `summons-answered-${answered.id}`,
    type: EVENT_TYPES.SUMMONS_ANSWERED,
    actorId: auth.member.id,
    atMs: nowOf(ctx.store),
    data: {
      summonsId: answered.id,
      labels: answered.labels,
      note: answered.note,
      summonerId: answered.createdBy,
      summonerDisplayName: displayNameOf(ctx.store, roomId, answered.createdBy),
      answererDisplayName: displayNameOf(ctx.store, roomId, auth.member.id),
    },
  });
  return ctx.json(ctx.res, 200, answered);
}

export async function withdrawSummonsRoute(ctx) {
  const { roomId, auth } = context(ctx, true);
  refuseArchived(ctx, roomId);
  const summonsId = ctx.params.summonsId;
  const summons = getSummons(ctx.store.db, roomId, summonsId);
  if (!summons) ctx.reject(404, "summons_not_found", "No such summons in this room");
  let state = null;
  try { state = ctx.store.room?.(roomId)?.state ?? null; } catch { state = null; }
  const allowed = summons.createdBy === auth.member.id
    || (state && memberCan(state, auth.member.id, "manage_members"));
  if (!allowed) ctx.reject(403, "access_denied", "Only the summoner or manage_members may withdraw a summons");
  try {
    return ctx.json(ctx.res, 200, withdrawSummons(ctx.store.db, roomId, summonsId, { now: nowOf(ctx.store) }));
  } catch (error) {
    if (error instanceof SummonsInputError) ctx.reject(422, "invalid_request", error.message);
    throw error;
  }
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const itemParameters = Object.freeze({ type: "object", required: ["roomId", "summonsId"], properties: { roomId: { type: "string" }, summonsId: { type: "string" } } });
const list = Object.freeze({ type: "array", items: { type: "string" } });
const PATH = "/api/rooms/{roomId}/summons";
const ITEM = "/api/rooms/{roomId}/summons/{summonsId}";

export const SUMMONS_ROUTES = Object.freeze([
  Object.freeze({ id: "summons-create", method: "POST", path: PATH,
    auth: "room", capability: null, scope: "room", handler: createSummonsRoute,
    schema: { params: parameters, body: { type: "object", additionalProperties: false, properties: { labels: list, note: { type: "string" } } }, response: { type: "object" } },
    events: [EVENT_TYPES.SUMMONS_ISSUED, EVENT_TYPES.SUMMONS_CALLED] }),
  Object.freeze({ id: "summons-list", method: "GET", path: PATH,
    auth: "room", capability: null, scope: "room", handler: listSummonsRoute,
    schema: { params: parameters, query: { type: "object", properties: { status: { type: "string" } } }, response: { type: "object" } },
    events: [] }),
  Object.freeze({ id: "summons-answer", method: "POST", path: `${ITEM}/answer`,
    auth: "room", capability: null, scope: "room", handler: answerSummonsRoute,
    schema: { params: itemParameters, response: { type: "object" } },
    events: [EVENT_TYPES.SUMMONS_ANSWERED] }),
  Object.freeze({ id: "summons-withdraw", method: "POST", path: `${ITEM}/withdraw`,
    auth: "room", capability: null, scope: "room", handler: withdrawSummonsRoute,
    schema: { params: itemParameters, response: { type: "object" } },
    events: [] }),
]);
