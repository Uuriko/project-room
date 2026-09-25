// HTTP routes for next-actions (RC-2026-09-25-911): the room's ranked
// per-agent "what should I do next" surface.
//
// Mounted from server/http.mjs via createNextActionsRoutes, which receives
// the server's local helpers. handleNextActionsRoutes returns true when it
// served the request, false so http.mjs can fall through to other routes.
//
// Paths follow the room's flat /api/rooms/{roomId}/<route> convention:
//   GET  /api/rooms/{roomId}/next-actions               ranked list (room-next-actions/1)
//   POST /api/rooms/{roomId}/next-actions-dismiss      {actionId, expiresInDays?, forever?, reason?}
//   GET  /api/rooms/{roomId}/next-actions-suppressions read-back (newest first)
//   PUT  /api/rooms/{roomId}/next-actions-suppressions {suppressions:[{kind, reason?}]} (replace-all)
//   GET  /api/rooms/{roomId}/next-actions-dismissals   read-back incl. lapsed rows
//
// Auth is the caller's room credential (Bearer identity secret or room
// cookie), resolved with the same roomCredentials helper as the other room
// routes; the NextActions class authenticates per call. Reads are
// rate-limited per member; every action.api emitted by the builder names a
// real route (never fabricated) — see tests/next-actions.test.js, which
// resolves each emitted path against the route patterns below.

import { NextActionsError } from "./next-actions.mjs";

const ROUTE = /^\/api\/rooms\/([^/]{1,384})\/(next-actions|next-actions-dismiss|next-actions-suppressions|next-actions-dismissals)$/;

export function createNextActionsRoutes({ store, json, reject, body, rate, roomCredentials, expectedBinding, accountBinding }) {
  // Coded pure-module errors -> HTTP: validation reads as 422.
  // store.authenticate failures surface as ServiceError with their status.
  const translate = handler => async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof NextActionsError) reject(422, error.code, error.message);
      if (error && typeof error.status === "number") reject(error.status, error.code ?? "next_actions_error", error.message);
      throw error;
    }
  };
  const nextActions = () => {
    if (!(store.nextActions instanceof Object) || typeof store.nextActions.list !== "function") {
      reject(500, "next_actions_unavailable", "Next-actions is not attached to this store");
    }
    return store.nextActions;
  };

  const serve = translate(async (req, res, url, remoteAddress) => {
    const match = ROUTE.exec(url.pathname);
    if (!match) return false;
    const roomId = match[1], route = match[2];
    const selected = roomCredentials(req, url);
    if (!selected.token) reject(401, "unauthenticated", "Authenticate: Authorization: Bearer <identitySecret>");
    const fence = selected.mode === "account" ? accountBinding(req) : expectedBinding(req);
    const memberKey = `next-actions:${roomId}:${selected.token.slice(0, 12)}`;
    const na = nextActions();

    if (route === "next-actions" && req.method === "GET") {
      rate(memberKey, 120);
      const limit = url.searchParams.get("limit");
      const kinds = url.searchParams.get("kinds");
      return json(res, 200, na.list(selected.token, roomId, {
        limit: limit === null ? 10 : Number(limit),
        kinds, binding: fence,
      }));
    }
    if (route === "next-actions-dismiss" && req.method === "POST") {
      rate(`next-actions-write:${roomId}:${selected.token.slice(0, 12)}`, 60);
      const payload = await body(req);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) reject(422, "invalid_input", "Supply {actionId, expiresInDays?, forever?, reason?}");
      return json(res, 200, na.dismiss(selected.token, roomId, payload.actionId, {
        expiresInDays: payload.expiresInDays ?? null,
        forever: payload.forever ?? false,
        reason: payload.reason ?? null,
        binding: fence,
      }));
    }
    if (route === "next-actions-suppressions" && req.method === "GET") {
      rate(memberKey, 120);
      return json(res, 200, na.getSuppressions(selected.token, roomId, fence));
    }
    if (route === "next-actions-suppressions" && req.method === "PUT") {
      rate(`next-actions-write:${roomId}:${selected.token.slice(0, 12)}`, 60);
      const payload = await body(req);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) reject(422, "invalid_input", "Supply {suppressions:[{kind, reason?}]}");
      return json(res, 200, na.putSuppressions(selected.token, roomId, { suppressions: payload.suppressions ?? [], binding: fence }));
    }
    if (route === "next-actions-dismissals" && req.method === "GET") {
      rate(memberKey, 120);
      return json(res, 200, na.readDismissals(selected.token, roomId, fence));
    }
    return false;
  });

  return async (req, res, { url, remoteAddress }) => serve(req, res, url, remoteAddress);
}
