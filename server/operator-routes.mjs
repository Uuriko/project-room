import {operatorLifecycleArchive} from './operator-lifecycle-archive.mjs';
import {operatorNormalization} from './operator-normalization.mjs';
import { operatorWakeIndex } from './operator-wake-index.mjs';
import { operatorAttachmentIndex } from './operator-attachment-index.mjs';
import { operatorMessageAuthority } from './operator-message-authority.mjs';
import { repairLegacyMessages } from './operator-legacy-message-repair.mjs';
import { retireQaRoom } from "./operator-qa-retirement.mjs";
// Operator HTTP surface. Mounted from createRoomServer. When the operator
// secret is unset this returns false and the request falls through to the
// same not_found path as any unknown URL.

import { configuredOperatorTokenHash, presentedOperatorToken, operatorTokenMatches, carriesRoomOrAccountCookie } from "./operator-auth.mjs";
import { createOperatorPurge } from "./operator-purge.mjs";
import { createOperatorRoomPurge } from "./operator-room-purge.mjs";
import { operatorStatus, operatorDrift } from "./operator-status.mjs";
import { listOperatorActions } from "./operator-actions.mjs";
import { operatorArchive } from "./operator-archive.mjs";
import { planProjectionRepair, executeProjectionRepair } from "./operator-projection-repair.mjs";
import { listOperatorRooms, operatorRoomExport } from "./operator-rooms.mjs";
import { writeGrantCensus } from "./operator-write-grant-census.mjs";

const POST = "POST";
const GET = "GET";
// MGMT-PANEL Slice 1 route rows (scope annotations for the H1 read/write
// split): GET /api/operator/rooms — scope: read;
// GET /api/operator/rooms/{roomId}/export — scope: read.
const ROOM_EXPORT_ROUTE = "/api/operator/rooms/{roomId}/export";
const ROOM_EXPORT_PATH = /^\/api\/operator\/rooms\/([^/]+)\/export$/;
const ROUTES = Object.freeze({
  "/api/operator/lifecycle-archive/plan": POST,
  "/api/operator/lifecycle-archive/execute": POST,
  "/api/operator/normalization/plan": POST,
  "/api/operator/normalization/execute": POST,
  "/api/operator/wakes/ordered-indexes/plan": POST,
  "/api/operator/wakes/ordered-indexes/execute": POST,
  "/api/operator/attachments/live-index/plan": POST,
  "/api/operator/attachments/live-index/execute": POST,
  "/api/operator/messages/authority/plan": POST,
  "/api/operator/messages/authority/execute": POST,
  "/api/operator/messages/authority/prepare": POST,
  "/api/operator/messages/legacy-repair/plan": POST,
  "/api/operator/messages/legacy-repair/execute": POST,
  "/api/operator/purge/plan": POST,
  "/api/operator/purge/find": POST,
  "/api/operator/purge/execute": POST,
  "/api/operator/archive": POST,
  "/api/operator/qa-retirement/plan": POST,
  "/api/operator/qa-retirement/execute": POST,
  "/api/operator/projection/plan": POST,
  "/api/operator/projection/execute": POST,
  "/api/operator/actions": GET,
  "/api/operator/status": GET,
  "/api/operator/drift": GET,
  "/api/operator/rooms": GET,
  "/api/operator/write-grants/census": GET,
  [ROOM_EXPORT_ROUTE]: GET
});

export function createOperatorRoutes({ store, json, reject, body, rate }) {
  const purge = createOperatorPurge(store);
  const roomPurge = createOperatorRoomPurge(store);
  return async function operatorRoutes(req, res, { url, remoteAddress, requestId }) {
    const path = url.pathname;
    if (path !== "/api/operator" && !path.startsWith("/api/operator/")) return false;
    if (!configuredOperatorTokenHash()) return false;
    rate(`operator:${remoteAddress || "unknown"}`, 10);
    const token = presentedOperatorToken(req.headers.authorization);
    if (carriesRoomOrAccountCookie(req.headers.cookie) && !token) reject(404, "not_found", "Not found");
    if (!operatorTokenMatches(token)) reject(404, "not_found", "Not found");
    // MGMT-PANEL Slice 2 (scope: write): the one parameterised operator
    // route family — panel Path-A purge plan/execute for a single room.
    const roomPurgeMatch = /^\/api\/operator\/rooms\/([^/]+)\/purge\/(plan|execute)$/.exec(path);
    if (roomPurgeMatch) {
      if (req.method !== POST) reject(405, "method_not_allowed", "Method not allowed");
      res.setHeader("Cache-Control", "no-store");
      let roomId = roomPurgeMatch[1];
      try { roomId = decodeURIComponent(roomId); } catch { /* wrapper refuses a malformed id */ }
      const data = await body(req);
      json(res, 200, roomPurgeMatch[2] === "plan"
        ? roomPurge.plan(roomId, data, requestId)
        : roomPurge.execute(roomId, data, requestId));
      return true;
    }
    // Minimal pattern extension for the one parameterised panel route; the
    // exact-match routes above are consulted first by construction (their
    // paths never match the export pattern, and vice versa).
    const exportMatch = ROOM_EXPORT_PATH.exec(path);
    const routeKey = exportMatch ? ROOM_EXPORT_ROUTE : path;
    const expected = ROUTES[routeKey];
    if (!expected) reject(404, "not_found", "Not found");
    if (req.method !== expected) reject(405, "method_not_allowed", "Method not allowed");
    res.setHeader("Cache-Control", "no-store");
    if (routeKey === "/api/operator/write-grants/census") {
      let result;
      try { result = writeGrantCensus(store, { after: url.searchParams.get("after"), scan: url.searchParams.get("scan") }); }
      catch (error) { if (error?.code === "invalid_scan" || error?.code === "invalid_cursor") reject(422, error.code, error.message); throw error; }
      json(res, 200, result);
      return true;
    }
    if (routeKey === "/api/operator/rooms") {
      json(res, 200, listOperatorRooms(store, url.searchParams.get("limit")));
      return true;
    }
    if (routeKey === ROOM_EXPORT_ROUTE) {
      let roomId = exportMatch[1];
      try { roomId = decodeURIComponent(roomId); } catch { reject(422, "invalid_room_id", "roomId must be a room id"); }
      if (url.searchParams.getAll("format").length > 1) reject(422, "invalid_format", "format is jsonl (default) or html");
      const result = operatorRoomExport(store, roomId, {
        format: url.searchParams.get("format") ?? "jsonl",
        confirmRoomId: url.searchParams.get("confirmRoomId"),
        reason: url.searchParams.get("reason")
      }, requestId);
      res.writeHead(200, {
        "Content-Type": result.contentType,
        "Content-Length": result.body.length,
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        ...result.headers
      });
      res.end(result.body);
      return true;
    }
    if (path === "/api/operator/wakes/ordered-indexes/plan" || path === "/api/operator/wakes/ordered-indexes/execute") {
      json(res, 200, operatorWakeIndex(store, await body(req), path.endsWith('/execute'), requestId));
      return true;
    }
    if(path==='/api/operator/lifecycle-archive/plan'||path==='/api/operator/lifecycle-archive/execute'){json(res,200,operatorLifecycleArchive(store,await body(req),path.endsWith('/execute')));return true;}
    if (path === '/api/operator/normalization/plan' || path === '/api/operator/normalization/execute') {
      json(res,200,operatorNormalization(store,await body(req),path.endsWith('/execute')));return true;
    }
    if (path === "/api/operator/attachments/live-index/plan" || path === "/api/operator/attachments/live-index/execute") {
      json(res, 200, operatorAttachmentIndex(store, await body(req), path.endsWith('/execute'), requestId));
      return true;
    }
    if (path === "/api/operator/qa-retirement/plan" || path === "/api/operator/qa-retirement/execute") {
      json(res, 200, retireQaRoom(store, await body(req), path.endsWith("/execute")));
      return true;
    }
    if (path === "/api/operator/messages/legacy-repair/plan" || path === "/api/operator/messages/legacy-repair/execute") {
      json(res, 200, repairLegacyMessages(store, await body(req), path.endsWith("/execute")));
      return true;
    }
    if (path === "/api/operator/purge/plan") {
      json(res, 200, purge.plan(await body(req), requestId));
      return true;
    }
    if (path === "/api/operator/purge/find") {
      json(res, 200, purge.find(await body(req), requestId));
      return true;
    }
    if (path === "/api/operator/purge/execute") {
      json(res, 200, purge.execute(await body(req), requestId));
      return true;
    }
    if (path === "/api/operator/messages/authority/plan" || path === "/api/operator/messages/authority/execute" || path === "/api/operator/messages/authority/prepare") {
      json(res, 200, operatorMessageAuthority(store, await body(req), path.endsWith("/prepare")?'prepare':path.endsWith("/execute"), requestId));
      return true;
    }
    if (path === "/api/operator/archive") {
      json(res, 200, operatorArchive(store, await body(req), requestId));
      return true;
    }
    if (path === "/api/operator/projection/plan") {
      json(res, 200, planProjectionRepair(store, await body(req), requestId));
      return true;
    }
    if (path === "/api/operator/projection/execute") {
      json(res, 200, executeProjectionRepair(store, await body(req), requestId));
      return true;
    }
    if (path === "/api/operator/actions") {
      const raw = url.searchParams.get("limit");
      const limit = raw == null ? 50 : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) reject(422, "invalid_limit", "limit must be an integer from 1 to 200");
      json(res, 200, { actions: listOperatorActions(store, limit) });
      return true;
    }
    if (path === "/api/operator/status") {
      let selection;
      if (url.searchParams.has('parityRoom') || url.searchParams.has('expectedHead')) {
        const rooms = url.searchParams.getAll('parityRoom'), heads = url.searchParams.getAll('expectedHead');
        if (rooms.length !== 1 || heads.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(rooms[0]) || !/^(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(heads[0]) || [...url.searchParams.keys()].some(key => !['parityRoom','expectedHead'].includes(key))) reject(422, 'invalid_request', 'Selected parity requires one room and an expected head from 1 to 64.');
        selection = { parityRoom: rooms[0], expectedHead: Number(heads[0]) };
      }
      json(res, 200, operatorStatus(store, selection));
      return true;
    }
    const main = url.searchParams.get("main");
    json(res, 200, operatorDrift(main));
    return true;
  };
}

// New operator paths use the existing dispatcher inventory while retaining
// this module's credential-first, fail-closed management boundary.
export const OPERATOR_ATTACHMENT_INDEX_ROUTES = Object.freeze(['plan', 'execute'].map(phase => Object.freeze({
  id: 'operator.attachment-live-index.' + phase, method: 'POST',
  path: '/api/operator/attachments/live-index/' + phase, mount: true,
  auth: 'none', capability: null, scope: 'worker', events: [],
  parity: 'exempt:operator-token-only maintenance; no public or MCP authority',
  schema: { body: { type: 'object' }, response: { type: 'object' } },
  async handler(ctx) {
    const handled = await ctx.operatorRoutes(ctx.req, ctx.res, { url: ctx.url, remoteAddress: ctx.remoteAddress, requestId: ctx.operationId });
    if (!handled) ctx.reject(404, 'not_found', 'Not found');
  }
})));
export const OPERATOR_WAKE_INDEX_ROUTES = Object.freeze(['plan', 'execute'].map(phase => Object.freeze({
  id: 'operator.wake-ordered-indexes.' + phase, method: 'POST',
  path: '/api/operator/wakes/ordered-indexes/' + phase, mount: true,
  auth: 'none', capability: null, scope: 'worker', events: [],
  parity: 'exempt:operator-token-only maintenance; no public or MCP authority',
  schema: { body: { type: 'object' }, response: { type: 'object' } },
  async handler(ctx) {
    const handled = await ctx.operatorRoutes(ctx.req, ctx.res, { url: ctx.url, remoteAddress: ctx.remoteAddress, requestId: ctx.operationId });
    if (!handled) ctx.reject(404, 'not_found', 'Not found');
  }
})));

export const OPERATOR_NORMALIZATION_ROUTES=Object.freeze(['plan','execute'].map(phase=>Object.freeze({
 id:'operator.normalization.'+phase,method:'POST',path:'/api/operator/normalization/'+phase,mount:true,auth:'none',capability:null,scope:'worker',events:[],
 parity:'exempt:existing operator-token-only explicit one-time materialization',schema:{body:{type:'object'},response:{type:'object'}},
 async handler(ctx){const handled=await ctx.operatorRoutes(ctx.req,ctx.res,{url:ctx.url,remoteAddress:ctx.remoteAddress,requestId:ctx.operationId});if(!handled)ctx.reject(404,'not_found','Not found');}
})));

export const OPERATOR_LIFECYCLE_ARCHIVE_ROUTES=Object.freeze(['plan','execute'].map(phase=>Object.freeze({
 id:'operator.lifecycle-archive.'+phase,method:'POST',path:'/api/operator/lifecycle-archive/'+phase,mount:true,auth:'none',capability:null,scope:'worker',events:[],
 parity:'exempt:existing operator-token-only explicit legacy room retirement',schema:{body:{type:'object'},response:{type:'object'}},
 async handler(ctx){const handled=await ctx.operatorRoutes(ctx.req,ctx.res,{url:ctx.url,remoteAddress:ctx.remoteAddress,requestId:ctx.operationId});if(!handled)ctx.reject(404,'not_found','Not found');}
})));
