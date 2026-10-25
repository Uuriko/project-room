// #3616 (R-5/R-11): decision-row export + evidence access log routes.
//
// Route-table rows (batch RT): the legacy allowlist only shrinks, so new
// routes live here, not in the legacy chain in server/http.mjs.
//
// Both routes are owner-only (requireExportOwner, the room export's
// gate). The export payload is materialised first; both audit records
// (the room.exported event naming schema version + row count +
// requester, and the evidence_access_log export row) are written
// before the payload is sent, so a failed audit write answers with an
// error instead of an unaudited download.

import { requireExportOwner, recordDecisionExport } from "../history-visibility.mjs";

function authorizeOwner(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req, null) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  if (auth.kind === "api-key") {
    const granted = (auth.apiKeyScopes ?? []).some(scope =>
      scope === "rooms:read" || (scope.endsWith(":*") && "rooms:read".startsWith(scope.slice(0, -1))));
    if (!granted) ctx.reject(403, "insufficient_scope", "API key lacks the rooms:read scope");
  }
  ctx.rate(`read:${auth.credentialHash}`, 600);
  requireExportOwner(ctx.store, roomId, auth.member.id, ctx.reject);
  return { selected, fence, auth };
}

export async function exportDecisionRows(ctx) {
  const roomId = ctx.params.roomId;
  const { selected, fence, auth } = authorizeOwner(ctx);
  if ([...ctx.url.searchParams.keys()].some(key => key !== "auth" || ctx.url.searchParams.getAll(key).length !== 1))
    ctx.reject(422, "invalid_decision_export", "The decision-row export takes no parameters");
  const payload = ctx.store.decisionRows.prepareExport(roomId, auth.member.id);
  recordDecisionExport(ctx.store, selected.token, roomId,
    { schemaVersion: payload.schema, rowCount: payload.rowCount, requesterId: auth.member.id }, fence); // R-11
  const audited = ctx.store.decisionRows.recordExportAudit(payload); // R-11 (evidence_access_log)
  return ctx.json(ctx.res, 200, audited, ctx.req.method === "HEAD");
}

export async function readDecisionAccessLog(ctx) {
  const roomId = ctx.params.roomId;
  authorizeOwner(ctx);
  const params = ctx.url.searchParams;
  if ([...params.keys()].some(key => !["limit", "auth"].includes(key) || params.getAll(key).length !== 1)
    || (params.has("limit") && (!/^[1-9]\d*$/.test(params.get("limit")) || Number(params.get("limit")) > 500)))
    ctx.reject(422, "invalid_access_log", "Choose an optional limit of 1 to 500");
  return ctx.json(ctx.res, 200, { roomId, entries: ctx.store.decisionRows.listAccessLog(roomId,
    { limit: params.has("limit") ? Number(params.get("limit")) : 100 }) }, ctx.req.method === "HEAD");
}

const parameters = Object.freeze({ type: "object", required: ["roomId"],
  properties: { roomId: { type: "string" } } });
const response = Object.freeze({ type: "object" });

export const DECISION_ROWS_ROUTES = Object.freeze([
  ...["GET", "HEAD"].map(method => Object.freeze({
    id: `decision-rows-export-${method}`, method, path: "/api/rooms/{roomId}/decision-rows",
    auth: "room", capability: null, scope: "room", handler: exportDecisionRows,
    parity: "exempt:auditor-export-with-no-mcp-tool",
    schema: { params: parameters, response }, events: ["room.exported"] })),
  ...["GET", "HEAD"].map(method => Object.freeze({
    id: `decision-rows-access-log-${method}`, method, path: "/api/rooms/{roomId}/decision-rows/access-log",
    auth: "room", capability: null, scope: "room", handler: readDecisionAccessLog,
    parity: "exempt:owner-audit-read-with-no-mcp-tool",
    schema: { params: parameters, query: { type: "object", properties: { limit: { type: "string" } } }, response }, events: [] })),
]);
