// Declarative HTTP route table (batch RT).
//
// Every route that has left the legacy chain in server/http.mjs is one frozen
// row. Unmatched paths fall through. Batch C fills `capability`. SPLIT reads
// `scope`. Both columns are required now.

import { AUTH_ROUTES } from "./auth.mjs";
import { INBOX_ROUTES } from "./inbox.mjs";
import { MEMBER_PERMISSION_ROUTES } from "./member-permissions.mjs";
import { AGENT_FLEET_ROUTES } from "./agents.mjs";
import { WANTS_WORK_ROUTES } from "./wants-work.mjs"; // BOARD-WAKE-2
import { WORK_CLAIM_ROUTES } from "./work-claims.mjs";
import { TYPING_ROUTES } from "./typing.mjs";
import { SPEND_GRANT_ROUTES } from "./spend-grants.mjs"; // spend-primitive MVP
import { SPEND_PRICING_ROUTES } from "./spend-pricing.mjs"; // spend-pricing kill switch
import { SQUAD_ROUTES } from "./squads.mjs"; // plan-squads

export const AUTH_CLASSES = Object.freeze(["none", "room", "account", "bearer", "roomToken", "door", "mcp"]);
export const ROUTE_SCOPES = Object.freeze(["worker", "public", "directory", "room"]);
export const ROUTE_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// Every `type` name the route-table schema validator (schemaErrors in
// dispatch.mjs) can enforce. An unknown name never matches any value, so a
// typo here silently 422s every request (2026-10-04 bughunt: type:"integer"
// rejected every number until the validator learned it). Fail closed at
// table-assertion time instead.
const KNOWN_SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

function unknownSchemaTypes(schema, out) {
  if (!schema || typeof schema !== "object") return out;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of types) if (!KNOWN_SCHEMA_TYPES.has(t)) out.push(t);
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const key of Object.keys(schema.properties)) unknownSchemaTypes(schema.properties[key], out);
  }
  if (schema.items) unknownSchemaTypes(schema.items, out);
  return out;
}

// Rows land here as groups leave the legacy chain. Do not push; replace the array.
export const ROUTES = Object.freeze([...AUTH_ROUTES, ...INBOX_ROUTES, ...MEMBER_PERMISSION_ROUTES, ...AGENT_FLEET_ROUTES, ...WANTS_WORK_ROUTES, ...WORK_CLAIM_ROUTES, ...SPEND_GRANT_ROUTES, ...SPEND_PRICING_ROUTES, ...SQUAD_ROUTES, ...TYPING_ROUTES]);

export function assertRouteRow(row) {
  const problems = [];
  if (!row || typeof row !== "object") return ["row"];
  if (typeof row.id !== "string" || row.id.length === 0) problems.push("id");
  if (!ROUTE_METHODS.includes(row.method)) problems.push("method");
  if (typeof row.path !== "string" || !row.path.startsWith("/")) problems.push("path");
  if (!AUTH_CLASSES.includes(row.auth)) problems.push("auth");
  if (!(row.capability === null || typeof row.capability === "string")) problems.push("capability");
  if (typeof row.handler !== "function") problems.push("handler");
  if (!row.schema || typeof row.schema !== "object" || Array.isArray(row.schema)) problems.push("schema");
  else if (!["params", "query", "body", "response"].some(key => row.schema[key] && typeof row.schema[key] === "object")) problems.push("schema");
  else {
    const unknown = [];
    for (const key of ["params", "query", "body", "response"]) unknownSchemaTypes(row.schema[key], unknown);
    if (unknown.length) problems.push(`schema: unknown type(s) ${[...new Set(unknown)].join(",")}`);
  }
  if (!Array.isArray(row.events)) problems.push("events");
  if (!ROUTE_SCOPES.includes(row.scope)) problems.push("scope");
  if (row.rate !== undefined && (typeof row.rate !== "object" || typeof row.rate.key !== "string" || !Number.isInteger(row.rate.max))) problems.push("rate");
  if (row.bodyLimit !== undefined && (!Number.isInteger(row.bodyLimit) || row.bodyLimit < 1)) problems.push("bodyLimit");
  return problems;
}

// PRIV-1: reads that can carry a message body. The redaction test walks this
// list. A new row here is a surface that must show no deleted text.
export const MESSAGE_BODY_READS = Object.freeze([
  Object.freeze({ id: "snapshot", group: "room", method: "GET", path: "/api/rooms/{roomId}" }),
  Object.freeze({ id: "events", group: "room", method: "GET", path: "/api/rooms/{roomId}/events?after=0&limit=100" }),
  Object.freeze({ id: "thread", group: "room", method: "GET", path: "/api/rooms/{roomId}/messages/{messageId}/thread" }),
  Object.freeze({ id: "search", group: "room", method: "GET", path: "/api/rooms/{roomId}/search?q={needle}" }),
  Object.freeze({ id: "export-jsonl", group: "room", method: "GET", path: "/api/rooms/{roomId}/export" }),
  Object.freeze({ id: "export-html", group: "room", method: "GET", path: "/api/rooms/{roomId}/export?format=html" }),
  Object.freeze({ id: "conversation", group: "room", method: "GET", path: "/api/rooms/{roomId}/conversation" }),
  Object.freeze({ id: "return-brief", group: "room", method: "GET", path: "/api/rooms/{roomId}/return-brief" }),
  Object.freeze({ id: "context", group: "room", method: "GET", path: "/api/rooms/{roomId}/context" }),
  Object.freeze({ id: "open-questions", group: "room", method: "GET", path: "/api/rooms/{roomId}/open-questions" }),
  Object.freeze({ id: "activity", group: "room", method: "GET", path: "/api/rooms/{roomId}/activity" }),
  Object.freeze({ id: "mentions", group: "room", method: "GET", path: "/api/rooms/{roomId}/mentions" }),
  Object.freeze({ id: "pins", group: "room", method: "GET", path: "/api/rooms/{roomId}/pins" }),
  // QA4 Q4-SEC-1: summary reads that carry pinned or recent message bodies.
  Object.freeze({ id: "activation-pack", group: "room", method: "GET", path: "/api/rooms/{roomId}/activation-pack" }),
  Object.freeze({ id: "orient-search", group: "room", method: "GET", path: "/api/rooms/{roomId}/orient?q={needle}" }),
  Object.freeze({ id: "stream", group: "room", method: "GET", path: "/api/rooms/{roomId}/stream?after=0", stream: true }),
  Object.freeze({ id: "agent-inbox", group: "room", method: "GET", path: "/api/rooms/{roomId}/agent-inbox", auth: "agent" }),
  Object.freeze({ id: "work-result", group: "receipt", method: "GET", path: "/api/rooms/{roomId}/work-result?workItemId={workItemId}" }),
  Object.freeze({ id: "mcp-list-events", group: "mcp", tool: "room_list_events" }),
  Object.freeze({ id: "mcp-read-messages", group: "mcp", tool: "room_read_messages" })
]);

export function assertRouteTable(routes = ROUTES) {
  const seen = new Set();
  const failures = [];
  for (const row of routes) {
    const problems = assertRouteRow(row);
    if (problems.length) failures.push(`${row?.id ?? "(missing id)"}: ${problems.join(", ")}`);
    else if (seen.has(row.id)) failures.push(`${row.id}: duplicate id`);
    else seen.add(row.id);
  }
  if (failures.length) throw new Error(`route table rejected:\n${failures.map(line => `  ${line}`).join("\n")}`);
  return routes;
}
