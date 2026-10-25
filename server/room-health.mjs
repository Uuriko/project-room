// Public room health. REST twins are GET /api/health and GET /api/health/jobs.
// The MCP tool room_health returns the same facts and still answers when the
// Durable Object cannot. A down room points at the status path. It does not
// send the caller to room_check_access, which needs the room too.

import { diagnoseArguments, mcpCallError } from "./mcp-arg-errors.mjs";
import { readWriterPermitHeal } from "./writer-permit-heal.mjs";

export const ROOM_HEALTH_SCHEMA = "room.health/1";
export const ROOM_HEALTH_RETRY_SECONDS = 30;
export const ROOM_HEALTH_STATUS_PATH = "/api/health";
export const ROOM_HEALTH_RETRY_COMMAND = "Wait for the Retry-After interval (30 seconds), then retry. If the failed call was a write whose outcome is unconfirmed, check its status before repeating it.";
export const ROOM_HEALTH_NEXT = Object.freeze([
  Object.freeze({ path: ROOM_HEALTH_STATUS_PATH }),
  Object.freeze({ command: ROOM_HEALTH_RETRY_COMMAND })
]);

export const ROOM_HEALTH_MCP_TOOL = Object.freeze({
  name: "room_health",
  description: "Read-only: Worker liveness, whether the Durable Object answered, the cron heartbeat, and the stale writer-permit reset count. No secret. REST: GET /api/health and GET /api/health/jobs. A down room returns status degraded with Retry-After and a status link.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});

export function isRoomHealthMcpCall(message) {
  return message?.method === "tools/call" && message?.params?.name === ROOM_HEALTH_MCP_TOOL.name;
}

export function roomHealthReport({
  mode,
  deployment,
  emailVerification,
  doStatus = null,
  jobs = null,
  writerPermitResets = null,
  degraded = false
} = {}) {
  return {
    schema: ROOM_HEALTH_SCHEMA,
    status: degraded ? "degraded" : "ok",
    mode,
    ...(deployment ? { deployment } : {}),
    ...(emailVerification ? { emailVerification, emailVerificationScope: "worker" } : {}),
    ...(doStatus ? { do: doStatus } : {}),
    jobs,
    writerPermitResets,
    ...(degraded ? { retryAfter: ROOM_HEALTH_RETRY_SECONDS, next: ROOM_HEALTH_NEXT } : {})
  };
}

export function roomHealthFromStore(store, { mode = "node", jobs = null } = {}) {
  return {
    schema: ROOM_HEALTH_SCHEMA,
    status: "ok",
    mode,
    jobs,
    writerPermitResets: readWriterPermitHeal(store?.db)
  };
}

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function roomHealthMcpReply(message, report) {
  if (!message || !Object.hasOwn(message, "id")) return null;
  const args = message.params?.arguments ?? {};
  const problems = diagnoseArguments(ROOM_HEALTH_MCP_TOOL.inputSchema, args);
  if (problems) return mcpCallError(message.id, { reason: "invalid_arguments", tool: ROOM_HEALTH_MCP_TOOL.name, ...problems });
  return { jsonrpc: "2.0", id: message.id, result: toolResult(report) };
}

export function roomHealthMcpResponse(message, report) {
  const reply = roomHealthMcpReply(message, report);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  };
  if (!reply) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(reply), { status: 200, headers });
}
