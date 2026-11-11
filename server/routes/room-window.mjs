import {readCurrentNeedsMePage} from '../current-needs-me.mjs';
import {isCurrentRoom} from '../current-room-repository.mjs';
import { listRoomWork } from '../mcp-room-profile.mjs';
import { readDirectConversations } from "../conversation-sync.mjs";
// Windowed room open and older-message page. Same authorization chain as
// the legacy room read: room credential, session fence, bearer room scope,
// read rate, rooms:read for API keys.
import { validId } from "../../src/events.js";
import { buildRoomBootstrap } from "../room-bootstrap.mjs";
import { readMessagePage, SNAPSHOT_WINDOW_MESSAGES } from "../snapshot-window.mjs";

function authorizeRoomRead(ctx) {
  const roomId = ctx.params.roomId;
  if (!validId(roomId)) ctx.reject(404, "not_found", "Not found");
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (auth.kind === "api-key") {
    const requiredScope = "rooms:read";
    const granted = (auth.apiKeyScopes ?? []).some(scope =>
      scope === requiredScope || (scope.endsWith(":*") && requiredScope.startsWith(scope.slice(0, -1))));
    if (!granted) ctx.reject(403, "insufficient_scope", `API key lacks the ${requiredScope} scope`);
  }
  return { selected, fence, roomId };
}

export function readRoomNeedsMe(ctx){
 const{selected,fence,roomId}=authorizeRoomRead(ctx),params=ctx.url.searchParams;
 if(singleQuery(params,['cursor','auth'])||params.has('cursor')&&(!params.get('cursor')||params.get('cursor').length>4096))ctx.reject(422,'invalid_cursor','Use the returned attention cursor unchanged');
 if(!isCurrentRoom(ctx.store.db,roomId))ctx.reject(409,'current_room_context_required','Use the existing Updates read for this legacy room');
 const value=ctx.store.readTransaction(()=>{const auth=ctx.roomAuth(selected,roomId,fence),page=readCurrentNeedsMePage(ctx.store,selected.token,roomId,{...(params.has('cursor')?{cursor:params.get('cursor')}:{}),expectedSessionBinding:fence});return{contractVersion:2,roomId,viewerId:auth.member.id,viewerAccountId:auth.account?.id??null,viewerAuthEpoch:auth.account?.authEpoch??null,viewerSessionBinding:auth.sessionBinding,viewerSessionRevision:auth.sessionRevision??null,...page};});
 return ctx.json(ctx.res,200,value,ctx.req.method==='HEAD');
}

function singleQuery(params, allowed) {
  return [...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1);
}

export function readRoomBootstrap(ctx) {
  const { selected, fence, roomId } = authorizeRoomRead(ctx);
  if (singleQuery(ctx.url.searchParams, ["auth"])) ctx.reject(422, "invalid_snapshot_view", "This read takes no query filters");
  const watchers = [...(ctx.streams ?? [])].filter(entry => entry.roomId === roomId).map(entry => entry.memberId);
  return ctx.json(ctx.res, 200, buildRoomBootstrap(ctx.store, selected.token, roomId, fence, {
    accessRequests: ctx.accessRequests, watchers
  }));
}

export function readRoomMessages(ctx) {
  const { selected, fence, roomId } = authorizeRoomRead(ctx);
  const params = ctx.url.searchParams;
  if (singleQuery(params, ["before", "beforeId", "limit", "auth"])
    || params.has("beforeId") && (!params.has("before") || !params.get("beforeId") || params.get("beforeId").length > 256)
    || params.has("limit") && !/^[1-9]\d*$/.test(params.get("limit"))
    || params.has("before") && !/^(0|[1-9]\d*)$/.test(params.get("before"))) {
    ctx.reject(422, "invalid_snapshot_view", "Choose a message page");
  }
  return ctx.json(ctx.res, 200, readMessagePage(ctx.store, selected.token, roomId, {
    beforeId: params.get("beforeId"),
    before: params.has("before") ? Number(params.get("before")) : null,
    limit: params.has("limit") ? Number(params.get("limit")) : SNAPSHOT_WINDOW_MESSAGES,
    expectedSessionBinding: fence
  }));
}

export function readRoomConversations(ctx) {
  const { selected, fence, roomId } = authorizeRoomRead(ctx);
  const params = ctx.url.searchParams;
  if (singleQuery(params, ["limit", "cursor", "auth"])
    || params.has("limit") && !/^[1-9]\d*$/.test(params.get("limit"))) ctx.reject(422, "invalid_conversation_selection", "Choose a bounded conversation list");
  return ctx.json(ctx.res, 200, readDirectConversations(ctx.store, selected.token, roomId, {
    limit: params.has("limit") ? Number(params.get("limit")) : 50,
    cursor: params.get("cursor"), expectedSessionBinding: fence
  }));
}

export function readRoomWorkList(ctx) {
  const { selected, fence, roomId } = authorizeRoomRead(ctx);
  const { url, store, reject, json, res } = ctx;
  const params = url.searchParams;
  if ([...params.keys()].some(key => !["focus", "limit", "cursor", "query", "sort", "auth"].includes(key) || params.getAll(key).length !== 1)
    || params.has("limit") && !/^[1-9]\d{0,2}$/.test(params.get("limit"))) reject(422, "invalid_work_page", "Choose one work listing and a returned cursor");
  const args = { roomId, expectedSessionBinding: fence };
  for (const key of ["focus", "cursor", "query", "sort"]) if (params.has(key)) args[key] = params.get(key);
  if (params.has("limit")) args.limit = Number(params.get("limit"));
  return json(res, 200, listRoomWork(store, selected.token, args));
}

const roomIdParam = { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } };

export const ROOM_WINDOW_ROUTES = Object.freeze([
  Object.freeze({id:'room-needs-me',method:'GET',path:'/api/rooms/{roomId}/needs-me',parity:'mcp:room_needs_me',auth:'room',capability:null,scope:'room',handler:readRoomNeedsMe,schema:{params:roomIdParam,query:{type:'object',properties:{cursor:{type:'string',minLength:1,maxLength:4096}}},response:{type:'object'}},events:[]}),
  Object.freeze({
    id: "room-work-list", method: "GET", path: "/api/rooms/{roomId}/work-list",
    parity: "mcp:room_list_work",
    auth: "room", capability: null, scope: "room", handler: readRoomWorkList,
    schema: { params: roomIdParam, query: { type: "object", properties: {
      focus: { type: "string", enum: ["all", "needs_me", "results", "help_wanted"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", minLength: 1, maxLength: 1024 },
      query: { type: "string", minLength: 1, maxLength: 200 },
      sort: { type: "string", enum: ["curiosity"] }
    } }, response: { type: "object" } }, events: []
  }),
  Object.freeze({
    id: "room-conversations", method: "GET", path: "/api/rooms/{roomId}/conversations",
    parity: "exempt:private conversation navigation metadata",
    auth: "room", capability: null, scope: "room", handler: readRoomConversations,
    schema: { params: roomIdParam, query: { type: "object", properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" }
    } }, response: { type: "object" } }, events: []
  }),
  Object.freeze({
    id: "room-bootstrap", method: "GET", path: "/api/rooms/{roomId}/bootstrap",
    parity: "mcp:room_read_bootstrap",
    auth: "room", capability: null, scope: "room", handler: readRoomBootstrap,
    schema: { params: roomIdParam, response: { type: "object" } }, events: []
  }),
  Object.freeze({
    id: "room-messages", method: "GET", path: "/api/rooms/{roomId}/messages",
    parity: "exempt:paged older history behind the shared room window",
    auth: "room", capability: null, scope: "room", handler: readRoomMessages,
    schema: {
      params: roomIdParam,
      query: { type: "object", properties: {
        before: { type: "integer", minimum: 0 },
        beforeId: { type: "string", minLength: 1, maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      } },
      response: { type: "object" }
    }, events: []
  })
]);
