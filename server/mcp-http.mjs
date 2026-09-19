// Streamable HTTP MCP join surface. Public packets / kits / snippets only.
// Room mutation tools stay on local stdio (scripts/agent-mcp.mjs).

import { MCP_VERSION, MCP_SUPPORTED_VERSIONS } from "../client/mcp-stdio.mjs";
import { llmsTxt, kitsTxt, joinPrompt } from "../deploy/agent-discovery.mjs";
import {
  isRoomMcpPath, roomMcpUrlForHost, roomMcpJoinText, roomMcpJoinJson, roomMcpSnippets, ROOM_MCP_SERVER_NAME
} from "../src/room-mcp-join.js";

export { isRoomMcpPath, MCP_VERSION };

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const JOIN_TOOLS = Object.freeze([
  Object.freeze({
    name: "room_join_packet",
    description: "Read the public Project Room llms.txt packet. No Room key. Not agent auth.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }),
  Object.freeze({
    name: "room_join_kits",
    description: "Read the public kits catalog. Catalog only; not an App Store.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }),
  Object.freeze({
    name: "room_join_prompt",
    description: "Read the one-paste door prompt (same bytes as /join.txt).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }),
  Object.freeze({
    name: "room_mcp_snippet",
    description: "Host-exact Claude / Cursor / Codex commands for this MCP URL.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })
]);

function toolResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], structuredContent: typeof value === "string" ? { text: value } : value };
}

export function handleMcpJoinRpc(message, { mcpUrl } = {}) {
  const url = mcpUrl || roomMcpUrlForHost("https://www.getdasha.com/room/mcp");
  const hasId = object(message) && Object.hasOwn(message, "id");
  const requestId = message?.id;
  if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string"
    || (hasId && !(typeof requestId === "string" && requestId.length <= 128 || Number.isSafeInteger(requestId)))) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  if (!hasId) return null;
  if (message.method === "ping") return { jsonrpc: "2.0", id: requestId, result: {} };
  if (message.method === "initialize") {
    const params = message.params;
    if (!object(params) || typeof params.protocolVersion !== "string" || !object(params.capabilities)
      || typeof params.clientInfo?.name !== "string" || typeof params.clientInfo?.version !== "string") {
      return { jsonrpc: "2.0", id: requestId, error: { code: -32602, message: "Invalid initialization" } };
    }
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSION;
    return {
      jsonrpc: "2.0", id: requestId,
      result: {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: ROOM_MCP_SERVER_NAME, version: "0.1.0" },
        instructions: "Public join MCP. Read packets and kits here. Room tools need local stdio plus an enrolled key or guest invite token. Do not invent credentials. A human invite link is not agent auth."
      }
    };
  }
  if (message.method === "tools/list") {
    if (message.params?.cursor !== undefined) {
      return { jsonrpc: "2.0", id: requestId, error: { code: -32602, message: "No pagination cursor is supported" } };
    }
    return { jsonrpc: "2.0", id: requestId, result: { tools: JOIN_TOOLS } };
  }
  if (message.method === "tools/call") {
    const selected = JOIN_TOOLS.find(tool => tool.name === message.params?.name);
    const args = message.params?.arguments ?? {};
    if (!selected || !object(args) || Object.keys(args).length) {
      return { jsonrpc: "2.0", id: requestId, error: { code: -32602, message: "Unknown tool or invalid arguments" } };
    }
    const value = selected.name === "room_join_packet" ? llmsTxt()
      : selected.name === "room_join_kits" ? kitsTxt()
        : selected.name === "room_join_prompt" ? joinPrompt()
          : roomMcpSnippets(url);
    return { jsonrpc: "2.0", id: requestId, result: toolResult(value) };
  }
  if (message.method === "server/discover") {
    return { jsonrpc: "2.0", id: requestId, error: { code: -32601, message: `Method not found; this server supports MCP ${MCP_SUPPORTED_VERSIONS.join(" and ")}` } };
  }
  return { jsonrpc: "2.0", id: requestId, error: { code: -32601, message: "Method not found" } };
}

export function mcpJoinCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version",
    "MCP-Protocol-Version": MCP_VERSION
  };
}

function joinDoc(url, accept) {
  const mcpUrl = roomMcpUrlForHost(url);
  const wantsJson = /application\/json/i.test(String(accept ?? "")) && !/text\/plain/i.test(String(accept ?? ""));
  return wantsJson
    ? { type: "application/json; charset=utf-8", body: JSON.stringify(roomMcpJoinJson(mcpUrl), null, 2) + "\n" }
    : { type: "text/plain; charset=utf-8", body: roomMcpJoinText(mcpUrl) };
}

export function roomMcpFetchResponse(request) {
  const url = new URL(request.url);
  if (!isRoomMcpPath(url.pathname)) return null;
  const cors = mcpJoinCorsHeaders();
  const headers = {
    ...cors,
    "Cache-Control": "no-store",
    "X-Robots-Tag": "all",
    "Referrer-Policy": "no-referrer"
  };
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...headers, Allow: "GET, HEAD, POST, OPTIONS" } });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const doc = joinDoc(url, request.headers.get("accept"));
    return new Response(request.method === "HEAD" ? null : doc.body, {
      headers: { ...headers, "Content-Type": doc.type }
    });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Method not allowed" } }), {
      status: 405, headers: { ...headers, Allow: "GET, HEAD, POST, OPTIONS", "Content-Type": "application/json; charset=utf-8" }
    });
  }
  return null;
}

export async function roomMcpFetchPost(request) {
  const url = new URL(request.url);
  const cors = mcpJoinCorsHeaders();
  const headers = {
    ...cors,
    "Cache-Control": "no-store",
    "X-Robots-Tag": "all",
    "Content-Type": "application/json; charset=utf-8"
  };
  let message;
  try {
    message = await request.json();
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }), {
      status: 400, headers
    });
  }
  const reply = handleMcpJoinRpc(message, { mcpUrl: roomMcpUrlForHost(url) });
  if (!reply) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(reply), { headers });
}

export function writeRoomMcpNode(req, res, url, { bodyText, accept } = {}) {
  const cors = mcpJoinCorsHeaders();
  const method = req.method;
  if (method === "OPTIONS") {
    res.writeHead(204, { ...cors, Allow: "GET, HEAD, POST, OPTIONS", "Cache-Control": "no-store" });
    return res.end();
  }
  if (method === "GET" || method === "HEAD") {
    const doc = joinDoc(url, accept ?? req.headers.accept);
    const bytes = Buffer.from(doc.body);
    res.writeHead(200, {
      ...cors,
      "Content-Type": doc.type,
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "all"
    });
    return res.end(method === "HEAD" ? undefined : bytes);
  }
  if (method !== "POST") {
    res.writeHead(405, { ...cors, Allow: "GET, HEAD, POST, OPTIONS", "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Method not allowed" } }));
  }
  let message;
  try { message = JSON.parse(bodyText); }
  catch {
    res.writeHead(400, { ...cors, "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }));
  }
  const reply = handleMcpJoinRpc(message, { mcpUrl: roomMcpUrlForHost(url) });
  if (!reply) {
    res.writeHead(202, { ...cors, "Cache-Control": "no-store" });
    return res.end();
  }
  const bytes = Buffer.from(JSON.stringify(reply));
  res.writeHead(200, {
    ...cors,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    "X-Robots-Tag": "all"
  });
  return res.end(bytes);
}
