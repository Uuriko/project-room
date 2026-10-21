// room ask: post to one agent and wait for its reply.
//   room ask <agent> <message...> [--timeout <seconds>]   (default 600)
//   room ask <agent> <message...> --fyi                   (posts without waking it)
// The reply is the agent's first message after the ask: a threaded reply to
// it, or any post by that agent. Exit 0 with the reply on stdout, 3 on timeout.
import { randomUUID } from "node:crypto";
import { bearerHeader, mcpUrl } from "../auth.mjs";
import { connection } from "./code.mjs";

export const DEFAULT_ASK_TIMEOUT_SECONDS = 600;

export function parseAskArgs(argv) {
  const words = [];
  let timeout = DEFAULT_ASK_TIMEOUT_SECONDS, fyi = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--fyi") { fyi = true; continue; }
    if (argv[i] === "--timeout") {
      timeout = Number(argv[++i]);
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) throw new Error("--timeout takes 1 to 86400 seconds");
      continue;
    }
    words.push(argv[i]);
  }
  const [agent, ...rest] = words;
  const message = rest.join(" ").trim();
  if (!agent || !message) throw new Error("Use room ask <agent> <message> [--timeout <seconds>] [--fyi]");
  return { agent: agent.replace(/^@_?/, ""), message, timeout, fyi };
}

export async function mcpTool(conn, name, args, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(mcpUrl(conn.origin), {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: bearerHeader(conn.secret) },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => null);
  const result = body?.result;
  if (!response.ok || body?.error || !result || result.isError) {
    throw new Error(`${name} failed (${response.status}): ${body?.error?.message ?? result?.content?.[0]?.text ?? "request failed"}`);
  }
  return result.structuredContent ?? {};
}

const lower = value => String(value ?? "").toLowerCase();
// Event pages wrap each entry as { sequence, event: { type, actorId, data } }.
const unwrap = entry => ({ sequence: Number(entry?.sequence) || 0, ...(entry?.event ?? entry) });

async function memberIdFor(conn, agent, fetchImpl) {
  let after = 0;
  for (let page = 0; page < 50; page += 1) {
    const listed = await mcpTool(conn, "room_list_events", { roomId: conn.roomId, after, limit: 100, type: "member.added", compact: true }, fetchImpl);
    const events = (listed.events ?? []).map(unwrap);
    const hit = events.find(e => lower(e.data?.memberId) === lower(agent) || lower(e.data?.displayName) === lower(agent));
    if (hit) return hit.data.memberId;
    if (!listed.hasMore || !events.length) return null;
    after = events.at(-1).sequence;
  }
  return null;
}

export async function askCommand(argv, { env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch, out = console.log, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(), pollMs = 2000 } = {}) {
  const { agent, message, timeout, fyi } = parseAskArgs(argv);
  const conn = await connection({ env, cwd });
  const memberId = await memberIdFor(conn, agent, fetchImpl);
  if (!memberId) { out(`No member named ${agent} in this room.`); return 1; }
  const messageId = randomUUID();
  // @_name is a silent mention: it names the agent without waking it.
  const body = `${fyi ? "@_" : "@"}${agent} ${message}`;
  const receipt = await mcpTool(conn, "room_post_message", { roomId: conn.roomId, id: messageId, messageId, body }, fetchImpl);
  if (fyi) { out(`Sent to ${agent} without waking it.`); return 0; }
  let after = Number(receipt.sequence ?? receipt.event?.sequence ?? 0);
  const deadline = now() + timeout * 1000;
  while (now() < deadline) {
    const listed = await mcpTool(conn, "room_list_events", { roomId: conn.roomId, after, limit: 100, type: "message.posted", compact: true }, fetchImpl);
    for (const event of (listed.events ?? []).map(unwrap)) {
      after = Math.max(after, Number(event.sequence) || after);
      if (event.data?.messageId === messageId) continue;
      if (event.data?.replyToId === messageId || event.actorId === memberId) {
        out(String(event.data?.body ?? ""));
        return 0;
      }
    }
    await sleep(pollMs);
  }
  out(`No reply from ${agent} within ${timeout}s.`);
  return 3;
}
