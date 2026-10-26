// Anonymous MCP answered by the Worker isolate, bypassing the Durable
// Object. The anonymous MCP surface is a pure function of deploy-static
// data (VERIFIED query census, cluster-05 Lane 05-01/05-08): tools/list
// with no Authorization runs ZERO store queries — handleMcpJoinRpc over
// frozen tool definitions — yet in production it paid the single DO's
// fixed per-request cost (prod p50 199 ms for a call whose handler work
// measures ~0 ms locally; PR #4965 probe, open). The MCP 2026-07-28
// stateless model (settled, cluster-07) means no session state exists
// to strand at the edge.
//
// Scope is exactly the store-free surface, decided by the same
// predicates the DO dispatch uses (server/mcp-http.mjs dispatchRoomMcp):
//   - GET / HEAD / OPTIONS on an MCP path (the join document / CORS),
//     via roomMcpFetchResponse, unchanged.
//   - POST with no presented credential (an empty Bearer counts as no
//     credential, matching dispatchRoomMcp) whose body is a well-formed
//     JSON-RPC object the pure join handler answers: initialize, ping,
//     tools/list, the four join tools/call, unknown-tool replies, and
//     notifications (202). Unparseable or non-object bodies fall
//     through: the DO boundary keeps owning malformed-request handling,
//     including its failure containment (503 room_unavailable when the
//     object is down — pinned by tests/job-heartbeat.test.js).
// Everything else returns null and the caller forwards the ORIGINAL
// request to the Durable Object untouched:
//   - any presented Authorization (authenticated calls route to the DO
//     exactly as before),
//   - anonymous tools/call for public-work tools or the identity-mint
//     tool — both are store-backed in dispatchRoomMcp, never pure,
//   - any non-MCP path. In particular /receipts/* and /r/*/proof are
//     not MCP paths and can never be answered here: no receipt content
//     is served or cached on this path (XW7 F2 carve-out — receipts are
//     excluded from any general cache/edge rollout until the F2
//     split-cache lands).
//
// POST responses replicate the Node door's writeRoomMcpNode POST shape
// (status, CORS/auth/legacy headers, Cache-Control, body bytes) so the
// edge answer is indistinguishable from the DO answer for the same
// message; the tests pin that parity against dispatchRoomMcp itself.
import {
  handleMcpJoinRpc, isRoomMcpPath, legacyMcpHeaders, mcpAuthHeaders,
  mcpJoinCorsHeaders, mcpRpcStatus, roomMcpFetchResponse,
} from "../server/mcp-http.mjs";
import { isPublicWorkMcpTool } from "../server/mcp-public-work.mjs";
import { isIdentityMintMcpTool } from "../server/mcp-identity-mint.mjs";
import { roomMcpUrlForHost } from "../src/room-mcp-join.js";

export function edgeMcpApplies(url) {
  return isRoomMcpPath(url.pathname);
}

// Response for a store-free anonymous MCP request, or null when the
// request belongs to the Durable Object. The caller must pass a request
// whose body it no longer needs (a clone): a null return means the
// original request is forwarded to the DO with its body unread here.
export async function edgeAnonymousMcpResponse(request, url) {
  if (!isRoomMcpPath(url.pathname)) return null;
  if (request.method !== "POST") return roomMcpFetchResponse(request);
  // Same presented-credential test as dispatchRoomMcp: an empty "Bearer"
  // (an MCP host config with an unset secret variable) is no credential.
  const authorization = request.headers.get("authorization");
  const presented = typeof authorization === "string" && !/^(?:bearer)?\s*$/i.test(authorization);
  if (presented) return null;
  const cors = mcpJoinCorsHeaders();
  let message;
  try {
    message = JSON.parse(await request.text());
  } catch {
    return null; // malformed body: the DO boundary owns it (see header)
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  // Store-backed anonymous calls stay with the DO, exactly as
  // dispatchRoomMcp routes them to the hosted room profile.
  if (message?.method === "tools/call"
    && (isPublicWorkMcpTool(message.params?.name) || isIdentityMintMcpTool(message.params?.name))) {
    return null;
  }
  const reply = handleMcpJoinRpc(message, { mcpUrl: roomMcpUrlForHost(url) });
  if (!reply) return new Response(null, { status: 202, headers: { ...cors, "Cache-Control": "no-store" } });
  const body = JSON.stringify(reply);
  return new Response(body, {
    status: mcpRpcStatus(reply),
    headers: {
      ...cors,
      ...mcpAuthHeaders(reply),
      ...legacyMcpHeaders(authorization),
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      "Cache-Control": "no-store",
      "X-Robots-Tag": "all",
    },
  });
}
