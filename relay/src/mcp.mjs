import { relayError } from "./errors.mjs";
import { MCP_PROTOCOL, MCP_PROTOCOLS, SERVER_NAME, SERVER_VERSION } from "./protocol.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function toolEnvelope(outcome) {
  if (outcome.ok) {
    const value = outcome.result ?? null;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const body = { content: [{ type: "text", text }], isError: false };
    if (value && typeof value === "object") body.structuredContent = value;
    return body;
  }
  const message = typeof outcome.error?.message === "string" && outcome.error.message
    ? outcome.error.message
    : "The machine refused the call";
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: { error: outcome.error ?? { code: "tool_failed", message } },
  };
}

export function parseRpc(message) {
  if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { error: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } } };
  }
  const hasId = Object.hasOwn(message, "id");
  const id = message.id;
  if (hasId && !(typeof id === "string" && id.length <= 128 || Number.isSafeInteger(id))) {
    return { error: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } } };
  }
  return { method: message.method, id: hasId ? id : null, notification: !hasId, params: message.params };
}

export function rpcResult(id, result, headers) {
  return { status: 200, body: { jsonrpc: "2.0", id, result }, headers };
}

export function rpcError(id, code, message) {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

export function initializeResult(id, params) {
  if (!object(params) || typeof params.protocolVersion !== "string" || !object(params.capabilities)
    || typeof params.clientInfo?.name !== "string" || typeof params.clientInfo?.version !== "string") {
    return rpcError(id, -32602, "Invalid initialization");
  }
  const protocolVersion = MCP_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : MCP_PROTOCOL;
  return rpcResult(id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: "Phase 0 clients send Authorization: Bearer. When the relay passthrough flag is on, that bearer is a Room identity secret or agent API key. Otherwise it is a Room lease token. This server does not issue OAuth tokens. Protected resource metadata names Room as the authorization server.",
  }, { "mcp-protocol-version": protocolVersion, "mcp-session-id": crypto.randomUUID() });
}

export function requireToolName(params) {
  const name = params?.name;
  if (typeof name !== "string" || name.length === 0) throw relayError(422, "invalid_call", "Name the tool");
  const args = params?.arguments ?? {};
  if (!object(args)) throw relayError(422, "invalid_call", "arguments must be an object");
  return { name, args };
}
