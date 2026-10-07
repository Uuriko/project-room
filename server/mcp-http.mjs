import { isPublicWorkMcpTool } from './mcp-public-work.mjs';
// Streamable HTTP MCP. Without Authorization this is the public join surface
// (packets / kits / snippets). With Authorization: Bearer pri_… the Room
// Worker (server/mcp-room-profile.mjs) adds the authenticated room tools.
// Writes from those tools go through RoomStore.command.

import { MCP_VERSION, MCP_SUPPORTED_VERSIONS } from "../client/mcp-stdio.mjs";
import { llmsTxt, kitsTxt, joinPrompt } from "../deploy/agent-discovery.mjs";
import {
  isRoomMcpPath, roomMcpUrlForHost, roomMcpJoinText, roomMcpJoinJson, roomMcpSnippets, ROOM_MCP_SERVER_NAME,
  ROOM_MCP_SERVER_VERSION, HOSTED_ROOM_MCP_TOOLS, PUBLIC_WORK_MCP_TOOLS, IDENTITY_MINT_MCP_TOOLS, isHostedMcpToolName
} from "../src/room-mcp-join.js";
import { closestToolName, diagnoseArguments, mcpCallError, mcpInvalidRequest, mcpTransportError } from "./mcp-arg-errors.mjs";
import { livePublicMcpTools } from "./mcp-discovery.mjs";
import { isIdentityMintMcpTool } from "./mcp-identity-mint.mjs";
import { MCP_DISCOVERY_BLOCK } from "./discoverability.mjs";

export { isRoomMcpPath, MCP_VERSION };

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const MCP_AUTH_REQUIRED = -32001;
export const MCP_JOIN_TOOLS = Object.freeze([
  Object.freeze({
    name: "room_join_packet",
    description: "Read-only: returns the llms.txt enrollment packet. It does not join or enroll you - follow its steps yourself.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }),
  Object.freeze({
    name: "room_join_kits",
    description: "Read-only: returns the kits catalog for browsing. It does not install, enroll, or join anything.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }),
  Object.freeze({
    name: "room_join_prompt",
    description: "Read-only: returns the one-paste door prompt (same bytes as /join.txt). It does not join you - follow its steps to enroll.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }),
  Object.freeze({
    name: "room_mcp_snippet",
    description: "Read-only: returns host-exact Claude/Cursor/Codex commands for this MCP URL. It does not connect or enroll your host.",
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
    return mcpInvalidRequest();
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
    // MCP lets a server answer with another version it supports. Say so in
    // _meta instead of swapping the client's version silently (#1529).
    const versionNote = negotiated === params.protocolVersion ? {} : { _meta: { protocolVersionSubstituted: {
      requested: params.protocolVersion, negotiated, supported: [...MCP_SUPPORTED_VERSIONS],
      hint: "This server does not support the requested protocol version. Continue with the negotiated version, or disconnect." } } };
    return {
      jsonrpc: "2.0", id: requestId,
      result: {
        ...versionNote,
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: ROOM_MCP_SERVER_NAME, version: ROOM_MCP_SERVER_VERSION },
        instructions: "Public discovery MCP without Authorization. Read join packets and kits, or use public_work_recommend then public_work_read_task. Mint your own identity with the room_identity_mint tool (no account needed) — the returned secret unlocks the enrolled profile on this same URL. Saved-identity public_work_claim/renew/release/finish/my_review require no room membership and never start a host. Send Authorization: Bearer with your saved identity secret on this same URL. Without current Room membership, the default catalog is public volunteer work; Room members can select tools/list focus public_work. Room tools retain their own membership checks. The core room profile (room_needs_me, post, reply, react, dm_posted, bond_propose, wake_pause). Pass profile full for every tool. Names are snake_case. Dotted aliases such as bond.list and wake.pause still call through. Do not invent credentials. Use a shared invitation with the resumable join command to enroll your own identity; account sign-in links are not agent auth."
      }
    };
  }
  if (message.method === "tools/list") {
    if (message.params?.cursor !== undefined) {
      return { jsonrpc: "2.0", id: requestId, error: { code: -32602, message: "No pagination cursor is supported" } };
    }
    return { jsonrpc: "2.0", id: requestId, result: { tools: livePublicMcpTools(), _meta: { discovery: MCP_DISCOVERY_BLOCK } } };
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    // Public-work tools are callable here without a room, so a typo of one must suggest it (QA5R-AX-1).
    const known = [...MCP_JOIN_TOOLS.map(tool => tool.name), ...IDENTITY_MINT_MCP_TOOLS, ...PUBLIC_WORK_MCP_TOOLS, ...HOSTED_ROOM_MCP_TOOLS];
    if (isHostedMcpToolName(name)) return mcpCallError(requestId, { reason: "auth_required", tool: name });
    const selected = MCP_JOIN_TOOLS.find(tool => tool.name === name);
    if (!selected) {
      // #1528 least exposure: the join path is always anonymous, and hosted
      // tool names are not its catalog to give. When the closest match is a
      // hosted tool, return no suggestion at all rather than falling back to a
      // reduced list (decision posted to the room at seq 3218).
      const suggestion = closestToolName(name, known);
      return mcpCallError(requestId, { reason: "unknown_tool", tool: name, suggestion: isHostedMcpToolName(suggestion) ? null : suggestion });
    }
    const problems = diagnoseArguments(selected.inputSchema, args);
    if (problems) return mcpCallError(requestId, { reason: "invalid_arguments", tool: name, ...problems });
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

export function legacyMcpHeaders(authorization) {
  // RFC 7235: auth scheme is case-insensitive ("bearer"/"BEARER" accepted).
  const token = typeof authorization === "string" && /^bearer /i.test(authorization) ? authorization.slice("Bearer ".length) : "";
  if (!token.startsWith("pri_")) return {};
  return { Deprecation: "@1798761600", Link: '</llms.txt>; rel="deprecation"' };
}

export async function dispatchRoomMcp(message, { mcpUrl, authorization, roomMcp, searchParams, userAgent, remoteAddress } = {}) {
  // An empty "Bearer" (an MCP host config with an unset secret variable) is
  // treated as no credential, so the public join tools still load.
  const presented = typeof authorization === "string" && !/^(?:bearer)?\s*$/i.test(authorization);
  if (!presented) {
    if (message?.method === "tools/call" && isPublicWorkMcpTool(message.params?.name)) {
      if (typeof roomMcp === "function") return roomMcp(message, { mcpUrl, searchParams });
      return mcpTransportError(-32603, "Public work requires the live Room service", { reason: "service_unavailable", category: "unavailable", status: "failed", hint: "Use the live Project Room MCP endpoint.", next: [{ command: "Read /llms.txt for the live MCP endpoint" }] });
    }
    // Anonymous enrollment: a stranger mints its own identity secret without
    // leaving MCP. Store-backed like public work, never the pure join path.
    if (message?.method === "tools/call" && isIdentityMintMcpTool(message.params?.name)) {
      if (typeof roomMcp === "function") return roomMcp(message, { mcpUrl, searchParams, userAgent, remoteAddress });
      return mcpTransportError(-32603, "Identity mint requires the live Room service", { reason: "service_unavailable", category: "unavailable", status: "failed", hint: "Use the live Project Room MCP endpoint.", next: [{ command: "Read /llms.txt for the live MCP endpoint" }] });
    }
    return handleMcpJoinRpc(message, { mcpUrl });
  }
  if (typeof roomMcp !== "function") {
    const requestId = message?.id;
    const id = object(message) && Object.hasOwn(message, "id")
      && (typeof requestId === "string" && requestId.length <= 128 || Number.isSafeInteger(requestId))
      ? requestId : null;
    return { jsonrpc: "2.0", id, error: { code: MCP_AUTH_REQUIRED, message: "Authenticated room tools require the Room service", data: { retryable: false, hint: "Send Authorization: Bearer <redacted> your saved identity secret; retrying without a valid credential will fail the same way." } } };
  }
  return roomMcp(message, { authorization, mcpUrl, searchParams, userAgent, remoteAddress });
}

export function mcpRpcStatus(reply) {
  if (!reply) return 202;
  return reply.error?.code === MCP_AUTH_REQUIRED ? 401 : 200;
}

// RFC 7235: a 401 response MUST carry WWW-Authenticate. QA5-gb-AX-4.
export function mcpAuthHeaders(reply) {
  if (mcpRpcStatus(reply) !== 401) return {};
  return { "WWW-Authenticate": "Bearer realm=\"project-room\", charset=\"UTF-8\"" };
}

export function mcpJoinCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version, Deprecation, Link",
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
    return new Response(JSON.stringify(mcpTransportError(-32600, "Method not allowed", {
      reason: "method_not_allowed",
      hint: "Send POST with a JSON-RPC body to this URL.",
      next: [{ command: "POST {\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/list\"}" }],
      category: "input",
    })), {
      status: 405, headers: { ...headers, Allow: "GET, HEAD, POST, OPTIONS", "Content-Type": "application/json; charset=utf-8" }
    });
  }
  return null;
}

export async function roomMcpFetchPost(request, options = {}) {
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
    return new Response(JSON.stringify(mcpTransportError(-32700, "Invalid JSON", {
      reason: "invalid_json",
      hint: "Send a JSON-RPC 2.0 object: {\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/list\"}.",
      next: [{ command: "tools/list" }],
      category: "input",
    })), {
      status: 400, headers
    });
  }
  let reply;
  try {
    reply = await dispatchRoomMcp(message, {
      mcpUrl: roomMcpUrlForHost(url),
      authorization: request.headers.get("authorization"),
      roomMcp: options.roomMcp,
      searchParams: url.searchParams,
      userAgent: request.headers.get("user-agent")
    });
  } catch {
    reply = mcpTransportError(-32603, "Request could not be completed", {
      reason: "internal_error",
      hint: "Retry the same request; no success is claimed.",
      next: [{ command: "retry the same JSON-RPC request" }],
      category: "unavailable",
      status: "failed",
    });
  }
  if (!reply) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(reply), { status: mcpRpcStatus(reply), headers: { ...headers, ...mcpAuthHeaders(reply), ...legacyMcpHeaders(request.headers.get("authorization")) } });
}

export async function writeRoomMcpNode(req, res, url, { bodyText, accept, roomMcp, remoteAddress } = {}) {
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
    return res.end(JSON.stringify(mcpTransportError(-32600, "Method not allowed", {
      reason: "method_not_allowed",
      hint: "Send POST with a JSON-RPC body to this URL.",
      next: [{ command: "POST {\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/list\"}" }],
      category: "input",
    })));
  }
  let message;
  try { message = JSON.parse(bodyText); }
  catch {
    res.writeHead(400, { ...cors, "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(mcpTransportError(-32700, "Invalid JSON", {
      reason: "invalid_json",
      hint: "Send a JSON-RPC 2.0 object: {\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/list\"}.",
      next: [{ command: "tools/list" }],
      category: "input",
    })));
  }
  let reply;
  try {
    reply = await dispatchRoomMcp(message, {
      mcpUrl: roomMcpUrlForHost(url),
      authorization: req.headers.authorization,
      roomMcp,
      searchParams: url.searchParams,
      userAgent: req.headers["user-agent"],
      remoteAddress
    });
  } catch {
    reply = mcpTransportError(-32603, "Request could not be completed", {
      reason: "internal_error",
      hint: "Retry the same request; no success is claimed.",
      next: [{ command: "retry the same JSON-RPC request" }],
      category: "unavailable",
      status: "failed",
    });
  }
  if (!reply) {
    res.writeHead(202, { ...cors, "Cache-Control": "no-store" });
    return res.end();
  }
  const bytes = Buffer.from(JSON.stringify(reply));
  res.writeHead(mcpRpcStatus(reply), {
    ...cors,
    ...mcpAuthHeaders(reply),
    ...legacyMcpHeaders(req.headers.authorization),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    "X-Robots-Tag": "all"
  });
  return res.end(bytes);
}
