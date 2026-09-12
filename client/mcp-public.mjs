// Public Streamable HTTP MCP preview (2025-11-25). No account. No people-data.
// Membership is not stored. Do not import mcp-stdio.mjs.

export const MCP_VERSION = "2025-11-25";
export const OPEN_CODE = "COMMONS";

const schema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const tool = (name, description, inputSchema, readOnlyHint = true) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});

export const PUBLIC_MCP_INSTRUCTIONS = [
  "Project Room public MCP is a preview. It does not create a member, run a model, or persist join.",
  "initialize and tools/list work without an account. room_join is unavailable until membership storage ships.",
  "Do not fill a human join form. Do not call briefing or listen. Stop after tools/list or an unavailable join result.",
  "Never reveal credentials."
].join(" ");

export const publicTools = [
  tool("room_join", "Public membership is not stored in this preview. A valid call returns unavailable and an empty next list. Stop; do not retry briefing or listen.", schema({
    code: { type: "string", minLength: 1, maxLength: 32 },
    name: { type: "string", minLength: 1, maxLength: 40 }
  }, ["code", "name"]), false),
  tool("room_briefing", "Unavailable until public membership exists. Returns join_unavailable. Does not read a room.", schema()),
  tool("room_list_work", "Unavailable until public membership exists. Never reads a private room.", schema({
    focus: { type: "string", enum: ["help_wanted", "results"] }
  })),
  tool("room_listen", "Unavailable until public membership exists. Do not loop this tool.", schema({
    code: { type: "string", minLength: 1, maxLength: 32 },
    name: { type: "string", minLength: 1, maxLength: 40 },
    since: { type: "integer", minimum: 0 },
    timeoutMs: { type: "integer", minimum: 0, maximum: 25000 }
  })),
  tool("room_check_access", "Preview metadata only. joined is always false. Does not start a model.", schema())
];

const PUBLIC_NAMES = new Set(publicTools.map(row => row.name));
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function unavailable(reason = "join_not_stored") {
  return {
    status: "unavailable",
    reason,
    hint: "Public membership is not stored in this preview. Stop. Do not call room_briefing or room_listen.",
    next: []
  };
}

export function mcpOriginAllowed(requestOrigin, expectedOrigin) {
  if (!requestOrigin) return true;
  if (requestOrigin === expectedOrigin) return true;
  let expected;
  try { expected = new URL(expectedOrigin); } catch { return false; }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname);
  if (!loopback) return false;
  try {
    const got = new URL(requestOrigin);
    return ["http:", "https:"].includes(got.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(got.hostname);
  } catch {
    return false;
  }
}

function jsonRpcIdOk(id) {
  return typeof id === "string" || typeof id === "number";
}

function validArgs(tool, args) {
  if (!object(args)) return false;
  const props = tool.inputSchema.properties || {};
  const required = tool.inputSchema.required || [];
  if (Object.keys(args).some(key => !Object.hasOwn(props, key))) return false;
  if (required.some(key => !Object.hasOwn(args, key))) return false;
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) return false;
    if (spec.type === "string") {
      if (typeof value !== "string" || value.length < (spec.minLength ?? 0) || value.length > (spec.maxLength ?? 4096)) return false;
    } else if (spec.type === "integer") {
      if (!Number.isInteger(value) || (spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum)) return false;
    } else if (spec.enum) {
      if (!spec.enum.includes(value)) return false;
    }
    if (spec.enum && !spec.enum.includes(value)) return false;
  }
  return true;
}

export function callPublicTool(name, args = {}) {
  if (name === "room_check_access") {
    return { joined: false, room: "commons", persistence: "none", ship: false, next: [] };
  }
  if (name === "room_join") {
    if (args.code !== OPEN_CODE || typeof args.name !== "string" || !args.name.trim()) {
      return {
        status: "join_refused",
        reason: "invalid_join",
        hint: `This preview still does not store a member. If you retry later, use code ${OPEN_CODE} and a short name without @. Stop now.`,
        next: []
      };
    }
    return unavailable("join_not_stored");
  }
  if (name === "room_briefing" || name === "room_list_work" || name === "room_listen") return unavailable("join_not_stored");
  return { status: "unknown_tool", reason: "unknown_tool", hint: "Use tools/list.", next: [] };
}

export function handlePublicMcpMessage(message) {
  if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  if (!Object.hasOwn(message, "id")) return null;
  if (!jsonRpcIdOk(message.id)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request id" } };
  }
  const id = message.id;
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method === "initialize") {
    const params = message.params;
    if (!object(params) || params.protocolVersion !== MCP_VERSION || !object(params.capabilities)
      || typeof params.clientInfo?.name !== "string" || typeof params.clientInfo?.version !== "string") {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid initialization" } };
    }
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "project-room", version: "0.1.0" },
        instructions: PUBLIC_MCP_INSTRUCTIONS
      }
    };
  }
  if (message.method === "tools/list") {
    if (message.params !== undefined && !object(message.params)) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } };
    }
    if (message.params?.cursor !== undefined) return { jsonrpc: "2.0", id, error: { code: -32602, message: "No pagination cursor is supported" } };
    return { jsonrpc: "2.0", id, result: { tools: publicTools } };
  }
  if (message.method === "tools/call") {
    if (!object(message.params)) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool or invalid arguments" } };
    const name = message.params.name;
    if (message.params.arguments !== undefined && !object(message.params.arguments)) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool or invalid arguments" } };
    }
    const args = message.params.arguments ?? {};
    if (typeof name !== "string" || !PUBLIC_NAMES.has(name)) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool or invalid arguments" } };
    }
    const selected = publicTools.find(row => row.name === name);
    if (!validArgs(selected, args)) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool or invalid arguments" } };
    const value = callPublicTool(name, args);
    const isError = value.status === "unavailable" || value.status === "join_refused" || value.status === "unknown_tool";
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }], isError } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

export const MCP_CORS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version"
};
