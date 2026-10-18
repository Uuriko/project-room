// Operator HTTP surface. Mounted from createRoomServer. When the operator
// secret is unset this returns false and the request falls through to the
// same not_found path as any unknown URL.

import { configuredOperatorTokenHash, presentedOperatorToken, operatorTokenMatches, carriesRoomOrAccountCookie } from "./operator-auth.mjs";
import { createOperatorPurge } from "./operator-purge.mjs";
import { operatorStatus, operatorDrift } from "./operator-status.mjs";
import { appendOperatorAction, listOperatorActions } from "./operator-actions.mjs";
import {
  escrowKeeperKillView, setEscrowKeeperKill, clearEscrowKeeperKill
} from "./bounty-epoch-keeper.mjs";

const POST = "POST";
const GET = "GET";
const ROUTES = Object.freeze({
  "/api/operator/purge/plan": POST,
  "/api/operator/purge/find": POST,
  "/api/operator/purge/execute": POST,
  "/api/operator/actions": GET,
  "/api/operator/status": GET,
  "/api/operator/drift": GET,
  "/api/operator/escrow-keeper": GET,
  "/api/operator/escrow-keeper/kill": POST,
  "/api/operator/escrow-keeper/resume": POST
});

const KEEPER_ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// Escrow keeper kill flag (AUDIT C-08 step-3 remainder): the operator
// surface for the keeper's dedicated halt. Authority is exactly this
// module's gate — the operator token — the same class as the
// deployment maintenance flag (operator configuration only, never a
// room permission). Body: { roomId?, reason? }; an absent roomId is
// the global scope. Returns the full flag view after the change.
function keeperScope(store, data, { kill, requestId }) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { status: 422, code: "invalid_keeper_kill", message: "Send a JSON object" };
  }
  const extra = Object.keys(data).filter(key => key !== "roomId" && key !== "reason");
  if (extra.length) return { status: 422, code: "invalid_keeper_kill", message: "Unexpected keeper fields" };
  const roomId = data.roomId ?? null;
  if (roomId !== null && (typeof roomId !== "string" || !KEEPER_ROOM_ID.test(roomId))) {
    return { status: 422, code: "invalid_keeper_kill", message: "roomId must be a room id" };
  }
  const reason = data.reason ?? null;
  if (reason !== null && (typeof reason !== "string" || reason.length > 200)) {
    return { status: 422, code: "invalid_keeper_kill", message: "reason must be a short string" };
  }
  const scope = roomId ?? "global";
  const before = escrowKeeperKillView(store);
  const wasKilled = roomId === null ? Boolean(before.global) : before.rooms.some(room => room.roomId === roomId);
  if (kill) setEscrowKeeperKill(store, { roomId, by: "operator", now: store.now() });
  else clearEscrowKeeperKill(store, { roomId });
  // Audit is best-effort: the kill is the safety action and must not
  // fail because the audit table is unavailable on some store shape.
  try {
    appendOperatorAction(store, {
      action: kill ? "escrow_keeper.kill" : "escrow_keeper.resume",
      targetKind: "escrow_keeper", targetId: scope, reason,
      result: kill ? (wasKilled ? "already_killed" : "killed") : (wasKilled ? "resumed" : "not_killed"),
      requestId
    });
  } catch (error) {
    console.error(`[operator] keeper kill audit failed: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  return { status: 200, body: { scope, ...escrowKeeperKillView(store) } };
}

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
    const expected = ROUTES[path];
    if (!expected) reject(404, "not_found", "Not found");
    if (req.method !== expected) reject(405, "method_not_allowed", "Method not allowed");
    res.setHeader("Cache-Control", "no-store");
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
    if (path === "/api/operator/escrow-keeper") {
      json(res, 200, escrowKeeperKillView(store));
      return true;
    }
    if (path === "/api/operator/escrow-keeper/kill" || path === "/api/operator/escrow-keeper/resume") {
      const result = keeperScope(store, await body(req), {
        kill: path.endsWith("/kill"), requestId
      });
      if (result.code) reject(result.status, result.code, result.message);
      json(res, result.status, result.body);
      return true;
    }
    const main = url.searchParams.get("main");
    json(res, 200, operatorDrift(main));
    return true;
  };
}
