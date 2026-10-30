// Operator HTTP surface. Mounted from createRoomServer. When the operator
// secret is unset this returns false and the request falls through to the
// same not_found path as any unknown URL.

import { configuredOperatorTokenHash, presentedOperatorToken, operatorTokenMatches, carriesRoomOrAccountCookie } from "./operator-auth.mjs";
import { createOperatorPurge } from "./operator-purge.mjs";
import { operatorStatus, operatorDrift } from "./operator-status.mjs";
import { listOperatorActions } from "./operator-actions.mjs";
import { operatorArchive } from "./operator-archive.mjs";
import { planProjectionRepair, executeProjectionRepair } from "./operator-projection-repair.mjs";
import { listOperatorRooms, operatorRoomExport } from "./operator-rooms.mjs";

const POST = "POST";
const GET = "GET";
// MGMT-PANEL Slice 1 route rows (scope annotations for the H1 read/write
// split): GET /api/operator/rooms — scope: read;
// GET /api/operator/rooms/{roomId}/export — scope: read.
const ROOM_EXPORT_ROUTE = "/api/operator/rooms/{roomId}/export";
const ROOM_EXPORT_PATH = /^\/api\/operator\/rooms\/([^/]+)\/export$/;
const ROUTES = Object.freeze({
  "/api/operator/purge/plan": POST,
  "/api/operator/purge/find": POST,
  "/api/operator/purge/execute": POST,
  "/api/operator/archive": POST,
  "/api/operator/projection/plan": POST,
  "/api/operator/projection/execute": POST,
  "/api/operator/actions": GET,
  "/api/operator/status": GET,
  "/api/operator/drift": GET,
  "/api/operator/rooms": GET,
  [ROOM_EXPORT_ROUTE]: GET
});

export function createOperatorRoutes({ store, json, reject, body, rate }) {
  const purge = createOperatorPurge(store);
  return async function operatorRoutes(req, res, { url, remoteAddress, requestId }) {
    const path = url.pathname;
    if (path !== "/api/operator" && !path.startsWith("/api/operator/")) return false;
    if (!configuredOperatorTokenHash()) return false;
    rate(`operator:${remoteAddress || "unknown"}`, 10);
    const token = presentedOperatorToken(req.headers.authorization);
    if (carriesRoomOrAccountCookie(req.headers.cookie) && !token) reject(404, "not_found", "Not found");
    if (!operatorTokenMatches(token)) reject(404, "not_found", "Not found");
    // Minimal pattern extension for the one parameterised panel route; the
    // exact-match routes above are consulted first by construction (their
    // paths never match the export pattern, and vice versa).
    const exportMatch = ROOM_EXPORT_PATH.exec(path);
    const routeKey = exportMatch ? ROOM_EXPORT_ROUTE : path;
    const expected = ROUTES[routeKey];
    if (!expected) reject(404, "not_found", "Not found");
    if (req.method !== expected) reject(405, "method_not_allowed", "Method not allowed");
    res.setHeader("Cache-Control", "no-store");
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
      json(res, 200, operatorStatus(store));
      return true;
    }
    const main = url.searchParams.get("main");
    json(res, 200, operatorDrift(main));
    return true;
  };
}
