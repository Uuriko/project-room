// server/a2a-jsonrpc.mjs — a public A2A JSON-RPC endpoint at /a2a.
//
// A2A clients (and the A2A Registry probe) can only talk to agents that serve
// the A2A JSON-RPC binding. This endpoint answers any message with the Room's
// join guide, so an A2A agent that finds Project Room learns how to join it.
// It holds no credentials, reads no room data and creates nothing. Room work
// stays on HTTP+JSON and MCP.
//
// Methods: message/send (A2A 0.3) and SendMessage (A2A 1.0). tasks/get and
// GetTask report that no task exists, because every answer is a direct
// message. Streaming is not offered. Task push-notification config is not
// implemented: those methods return -32003 PushNotificationNotSupported
// (QA2 finding P2-5), which is the A2A error for a card that declares
// capabilities.pushNotifications false.

import { createHash } from "node:crypto";
import { ROOM_ORIGIN, joinPrompt } from "../deploy/agent-discovery.mjs";

export const A2A_PATHS = Object.freeze(["/a2a", "/a2a/", "/room/a2a", "/room/a2a/"]);
export const isA2aPath = pathname => A2A_PATHS.includes(pathname);

const SEND = new Set(["message/send", "SendMessage"]);
const GET_TASK = new Set(["tasks/get", "GetTask"]);
const CANCEL_TASK = new Set(["tasks/cancel", "CancelTask"]);

// A2A 0.3 slash names and A2A 1.0 PascalCase names for Task push config.
// A method in this family exists; the server refuses it instead of
// answering method-not-found.
function isPushConfigMethod(method) {
  return method === "CreateTaskPushNotificationConfig"
    || method === "GetTaskPushNotificationConfig"
    || method === "ListTaskPushNotificationConfig"
    || method === "ListTaskPushNotificationConfigs"
    || method === "DeleteTaskPushNotificationConfig"
    || (typeof method === "string" && method.startsWith("tasks/pushNotificationConfig/"));
}

export function a2aReplyText() {
  return `Project Room is a shared room where people and AI agents work on one project together.

To join a room, ask its owner for an invite link (it ends in #join/...), then:
  ${joinPrompt().trim()}

To start your own room without an account, follow "Create Room" in ${ROOM_ORIGIN}/llms.txt.
MCP clients can add ${"https://www.getdasha.com/room/mcp"} instead.`;
}

const validId = id => typeof id === "string" && id.length > 0 && id.length <= 128 || Number.isSafeInteger(id);
const error = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });

function incomingText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts.map(part => typeof part?.text === "string" ? part.text : "").join("\n").slice(0, 4000);
}

// Deterministic ids: the same request gets the same reply id, so a retry is
// recognisable and nothing is stored.
const replyId = (messageId, text) => `pr-${createHash("sha256").update(`${messageId}\n${text}`).digest("hex").slice(0, 32)}`;

export function handleA2aRpc(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return error(null, -32600, "Invalid Request: send one JSON-RPC 2.0 object");
  }
  const id = Object.hasOwn(message, "id") && validId(message.id) ? message.id : null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return error(id, -32600, "Invalid Request: jsonrpc must be \"2.0\" with a method");
  if (!Object.hasOwn(message, "id")) return null; // a notification gets no reply
  if (SEND.has(message.method)) {
    const incoming = message.params?.message;
    if (!incoming || typeof incoming !== "object" || typeof incoming.messageId !== "string" || !incoming.messageId) {
      return error(id, -32602, "Invalid params: params.message with a messageId is required");
    }
    const text = a2aReplyText();
    const messageId = replyId(incoming.messageId, incomingText(incoming));
    const contextId = typeof incoming.contextId === "string" && incoming.contextId.length <= 128 ? incoming.contextId : undefined;
    if (message.method === "SendMessage") {
      return { jsonrpc: "2.0", id, result: { message: { messageId, ...(contextId ? { contextId } : {}), role: "ROLE_AGENT", parts: [{ text }] } } };
    }
    return { jsonrpc: "2.0", id, result: { kind: "message", messageId, ...(contextId ? { contextId } : {}), role: "agent", parts: [{ kind: "text", text }] } };
  }
  if (GET_TASK.has(message.method) || CANCEL_TASK.has(message.method)) {
    return error(id, -32001, "Task not found: this agent answers with messages, not tasks");
  }
  if (isPushConfigMethod(message.method)) {
    return error(id, -32003, "PushNotificationNotSupported");
  }
  return error(id, -32601, `Method not found: use message/send or SendMessage`);
}

const headers = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, A2A-Version",
});

// Node handler. bodyText is read by the caller under its JSON size cap.
export function writeA2aNode(req, res, { bodyText } = {}) {
  if (req.method === "OPTIONS") { res.writeHead(204, { ...headers, Allow: "POST, OPTIONS" }); return res.end(); }
  if (req.method !== "POST") {
    res.writeHead(405, { ...headers, Allow: "POST, OPTIONS" });
    return res.end(JSON.stringify(error(null, -32600, `POST a JSON-RPC 2.0 message/send request. Agent card: ${ROOM_ORIGIN}/.well-known/agent-card.json`)));
  }
  let message;
  try { message = JSON.parse(bodyText ?? ""); }
  catch { res.writeHead(400, headers); return res.end(JSON.stringify(error(null, -32700, "Parse error: send valid JSON"))); }
  const reply = handleA2aRpc(message);
  if (!reply) { res.writeHead(202, headers); return res.end(); }
  res.writeHead(200, headers);
  return res.end(JSON.stringify(reply));
}
