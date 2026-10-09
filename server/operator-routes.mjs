// Operator HTTP surface. Mounted from createRoomServer. When the operator
// secret is unset this returns false and the request falls through to the
// same not_found path as any unknown URL.

import { configuredOperatorTokenHash, presentedOperatorToken, operatorTokenMatches, carriesRoomOrAccountCookie } from "./operator-auth.mjs";
import { createOperatorPurge } from "./operator-purge.mjs";
import { operatorStatus, operatorDrift } from "./operator-status.mjs";
import { listOperatorActions } from "./operator-actions.mjs";

const ROUTES = Object.freeze({
  "/api/operator/purge/plan": "POST",
  "/api/operator/purge/find": "POST",
  "/api/operator/purge/execute": "POST",
  "/api/operator/actions": "GET",
  "/api/operator/status": "GET",
  "/api/operator/drift": "GET"
});
// Purge dispatch: all three share the same shape — body(req) in, purge op out.
const PURGE_OPS = Object.freeze({
  "/api/operator/purge/plan": "plan",
  "/api/operator/purge/find": "find",
  "/api/operator/purge/execute": "execute"
});

export function createOperatorRoutes({ store, json, reject, body, rate }) {
  const purge = createOperatorPurge(store);
  return async function operatorRoutes(req, res, { url, remoteAddress, requestId }) {
    const path = url.pathname;
    if (path !== "/api/operator" && !path.startsWith("/api/operator/")) return false;
    if (!configuredOperatorTokenHash()) return false;
    rate(`operator:${remoteAddress || "unknown"}`, 10);
    const token = presentedOperatorToken(req.headers.authorization);
    if ((carriesRoomOrAccountCookie(req.headers.cookie) && !token) || !operatorTokenMatches(token)) {
      reject(404, "not_found", "Not found");
    }
    const expected = ROUTES[path];
    if (!expected) reject(404, "not_found", "Not found");
    if (req.method !== expected) reject(405, "method_not_allowed", "Method not allowed");
    res.setHeader("Cache-Control", "no-store");
    const purgeOp = PURGE_OPS[path];
    if (purgeOp) {
      json(res, 200, purge[purgeOp](await body(req), requestId));
      return true;
    }
    if (path === "/api/operator/actions") {
      const raw = url.searchParams.get("limit");
      const limit = raw == null ? 50 : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) reject(422, "invalid_limit", "limit must be an integer from 1 to 200");
      json(res, 200, { actions: listOperatorActions(store, limit) });
      return true;
    }
    // Only /api/operator/status and /api/operator/drift reach here.
    json(res, 200, path === "/api/operator/status" ? operatorStatus(store) : operatorDrift(url.searchParams.get("main")));
    return true;
  };
}
