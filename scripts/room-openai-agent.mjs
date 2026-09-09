import { pathToFileURL } from "node:url";
import { completeChat, readOpenAIKey } from "../server/openai-complete.mjs";

const AGENT_KEY_ENV = "ROOM_AGENT_KEY";
const OPENAI_KEY_ENV = "PROJECT_ROOM_OPENAI_API_KEY";
const DEFAULT_ORIGIN = "http://127.0.0.1:4173";
const DEFAULT_ROOM = "commons";
const MESSAGE_POSTED = "message.posted";
const BODY_LIMIT = 4096;

export function missingOperatorEnv(env = process.env) {
  const missing = [];
  if (typeof env[AGENT_KEY_ENV] !== "string" || !env[AGENT_KEY_ENV].trim()) missing.push(AGENT_KEY_ENV);
  if (!readOpenAIKey(env)) missing.push(OPENAI_KEY_ENV);
  return missing;
}

export function loopbackOrigin(value = DEFAULT_ORIGIN) {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password) {
    throw new Error("Use a fixed loopback origin");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use a fixed loopback origin");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Agent runner is loopback-only");
  }
  return url.origin;
}

function isDirectedAt(event, viewerId) {
  return event?.type === MESSAGE_POSTED
    && event.actorId
    && event.actorId !== viewerId
    && event.data?.toMemberId === viewerId
    && typeof event.data.body === "string"
    && event.data.body.trim();
}

function roomHeaders(env, json = false) {
  return {
    Authorization: `Bearer ${env[AGENT_KEY_ENV]}`,
    ...(json ? { "Content-Type": "application/json" } : {})
  };
}

async function roomRequest(fetchImpl, origin, path, env, body) {
  const response = await fetchImpl(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    credentials: "omit",
    headers: roomHeaders(env, body !== undefined),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "Room request failed");
  return value;
}

export function replyCommand(event, text, { commandId, messageId } = {}) {
  const body = text.trim().slice(0, BODY_LIMIT);
  return {
    id: commandId ?? crypto.randomUUID(),
    type: MESSAGE_POSTED,
    causationId: event.id,
    data: {
      messageId: messageId ?? crypto.randomUUID(),
      body,
      replyToId: event.data.messageId || event.id,
      toMemberId: event.actorId
    }
  };
}

export async function runCycle({ env = process.env, fetchImpl = globalThis.fetch, after = 0, ids } = {}) {
  const missing = missingOperatorEnv(env);
  if (missing.length) {
    return { ok: false, posted: false, missing, command: null, next: after };
  }
  const origin = loopbackOrigin(env.ROOM_AGENT_ORIGIN || DEFAULT_ORIGIN);
  const roomId = env.ROOM_AGENT_ROOM || DEFAULT_ROOM;
  const session = await roomRequest(fetchImpl, origin, "/api/session", env);
  const viewerId = session.member?.id;
  if (!viewerId) throw new Error("Session has no member");
  const page = await roomRequest(
    fetchImpl,
    origin,
    `/api/rooms/${encodeURIComponent(roomId)}/events?after=${after}&limit=100`,
    env
  );
  const events = Array.isArray(page.events) ? page.events : [];
  const hit = events.find(item => isDirectedAt(item.event, viewerId));
  if (!hit) {
    return { ok: true, posted: false, missing: [], command: null, next: page.next ?? after };
  }
  const text = await completeChat({
    env,
    fetchImpl,
    messages: [{ role: "user", content: hit.event.data.body }]
  });
  const command = replyCommand(hit.event, text, ids);
  await roomRequest(fetchImpl, origin, `/api/rooms/${encodeURIComponent(roomId)}/commands`, env, command);
  return { ok: true, posted: true, missing: [], command, next: hit.sequence ?? page.next ?? after };
}

export async function main(env = process.env, io = console) {
  const missing = missingOperatorEnv(env);
  if (missing.length) {
    io.error(`Missing ${missing.join(" and ")}.`);
    return 1;
  }
  const once = process.argv.includes("--once");
  let after = 0;
  do {
    const result = await runCycle({ env, after });
    after = result.next ?? after;
    if (once) return 0;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => {
    if (code) process.exitCode = code;
  }).catch(() => {
    console.error("Agent runner stopped. No invented reply was posted.");
    process.exitCode = 1;
  });
}

export { AGENT_KEY_ENV, OPENAI_KEY_ENV, DEFAULT_ORIGIN, DEFAULT_ROOM, MESSAGE_POSTED };
