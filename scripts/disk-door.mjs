// Disk door: joins the shared-disk agent channel (~/src/agent-bus/channel.jsonl,
// one JSON object per line: {at, from, body}) to one Room. Agents that share a
// computer but cannot reach the Room origins (sandboxed VMs, TUIs without MCP)
// append a line; whoever runs this with a Room identity relays it in, and room
// messages come back as lines with from "room:<name>".
//
// Run it where an identity already lives (for example next to the Grok host):
//   node scripts/disk-door.mjs sync --channel ~/src/agent-bus/channel.jsonl
// with ROOM_AGENT_CONFIG pointing at the saved connection directory.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { agentConnectionFromEnvironment } from "../client/agent-connection.mjs";
import { MAX_MESSAGE_BODY_CHARS } from "../src/events.js";

export const ROOM_PREFIX = "room:";

export function lineId(line) {
  const h = createHash("sha256").update(`disk-door:${line}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// New channel lines after byte offset `from`, skipping lines the door wrote.
export function readChannel(text, from = 0) {
  const out = []; let offset = from;
  const chunk = text.slice(from);
  const complete = chunk.lastIndexOf("\n") + 1; // never read a half-written line
  for (const raw of chunk.slice(0, complete).split("\n")) {
    const start = offset; offset += raw.length + 1;
    if (!raw.trim()) continue;
    let entry; try { entry = JSON.parse(raw); } catch { continue; }
    if (typeof entry?.from !== "string" || typeof entry?.body !== "string" || !entry.body.trim()) continue;
    if (entry.from.startsWith(ROOM_PREFIX)) continue;
    out.push({ raw, start, from: entry.from, body: entry.body, at: entry.at ?? null });
  }
  return { entries: out, offset: from + complete };
}

export function channelCommand(entry) {
  const header = `**${entry.from}** via Mac channel (unverified): `;
  const body = entry.body.length > MAX_MESSAGE_BODY_CHARS - header.length ? entry.body.slice(0, MAX_MESSAGE_BODY_CHARS - header.length - 1) + "…" : entry.body;
  const id = lineId(entry.raw);
  return { id, type: "message.posted", data: { messageId: id, body: header + body } };
}

export function roomLines(messages, { selfMemberId, names = {}, cursor = 0 } = {}) {
  const lines = []; let last = cursor;
  for (const m of messages ?? []) {
    last = Math.max(last, m.sequence ?? 0);
    if (m.sequence <= cursor || m.private || m.from === selfMemberId) continue;
    lines.push(JSON.stringify({ at: m.at ?? new Date().toISOString(), from: `${ROOM_PREFIX}${names[m.from] ?? m.from}`,
      body: m.body, messageId: m.messageId, seq: m.sequence }));
  }
  return { lines, cursor: last };
}

export function loadState(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { offset: null, seq: null }; }
}
function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(state)); chmodSync(file, 0o600);
}

export async function sync({ client, channel, stateFile, selfMemberId, names = {}, now = () => new Date() }) {
  const text = existsSync(channel) ? readFileSync(channel, "utf8") : "";
  const state = loadState(stateFile);
  // First run starts at the end of both sides: no flood of old history.
  if (state.offset === null || state.seq === null) {
    let seq = 0, after = 0;
    for (let i = 0; i < 200; i++) { const p = await client.roomMessages({ after, limit: 100 }); seq = p.next; if (!p.hasMore || p.next === after) break; after = p.next; }
    saveState(stateFile, { offset: text.length, seq });
    return { started: true, offset: text.length, seq };
  }
  const { entries, offset } = readChannel(text, state.offset);
  let sent = 0;
  for (const entry of entries) { await client.command(channelCommand(entry)); sent++; saveState(stateFile, { ...state, offset: entry.start + entry.raw.length + 1 }); }
  const messages = []; let after = state.seq;
  for (let i = 0; i < 20; i++) { const p = await client.roomMessages({ after, limit: 100 }); messages.push(...p.messages); if (!p.hasMore || p.next === after) { after = p.next; break; } after = p.next; }
  const { lines, cursor } = roomLines(messages, { selfMemberId, names, cursor: state.seq });
  if (lines.length) appendFileSync(channel, lines.join("\n") + "\n");
  const endOffset = lines.length ? readFileSync(channel, "utf8").length : offset;
  saveState(stateFile, { offset: endOffset, seq: Math.max(cursor, after ?? 0), at: now().toISOString() });
  return { sent, received: lines.length, seq: Math.max(cursor, after ?? 0) };
}

export async function main(env = process.env, argv = process.argv) {
  const arg = name => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
  if (argv[2] !== "sync") throw new Error("usage: disk-door.mjs sync --channel FILE [--state FILE]");
  const channel = arg("--channel") ?? `${env.HOME}/src/agent-bus/channel.jsonl`;
  const stateFile = arg("--state") ?? `${env.HOME}/.project-room/disk-door-state.json`;
  // Same saved connection every Room tool uses (ROOM_AGENT_CONFIG directory).
  const config = agentConnectionFromEnvironment(env);
  if (!config?.memberId) throw new Error("Use a saved connection with a memberId so the door never relays its own posts");
  const memberId = config.memberId;
  const client = new RoomAgentClient({ origin: config.origin, roomId: config.roomId, token: config.token, memberId });
  console.log(JSON.stringify({ ok: true, ...(await sync({ client, channel, stateFile, selfMemberId: memberId })) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
