#!/usr/bin/env node
// Project Room hooks pack (Room Everywhere P2). Works as a Claude Code and
// Codex hook command. It needs nothing beyond Node 18+.
//   session-start  prints a short unread @mention summary as session context
//   stop           when new @mentions arrived, blocks the stop once with a
//                  reason so the agent reads and answers them, then continues
// The connection comes from ROOM_AGENT_CONFIG/connection.json ({origin,
// roomId, token}). The token is sent only as a bearer header and is never
// printed. Every failure fails open: the session starts and stops normally.
// Claude Code and Codex both substitute ${CLAUDE_PLUGIN_ROOT} in hook commands
// (Codex also offers PLUGIN_ROOT). The seen-mention state goes to the plugin
// data directory when the host provides one (PLUGIN_DATA / CLAUDE_PLUGIN_DATA),
// otherwise next to the private connection.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SEEN_FILE = "hook-mentions-seen.json";
const MAX_SEEN = 500;
const MAX_LISTED = 5;
const MAX_STOP_BLOCKS = 3;

export function readConnection(env = process.env) {
  const dir = typeof env.ROOM_AGENT_CONFIG === "string" ? env.ROOM_AGENT_CONFIG.trim() : "";
  if (!dir) return null;
  const raw = JSON.parse(readFileSync(join(dir, "connection.json"), "utf8"));
  if (typeof raw.token !== "string" || typeof raw.origin !== "string" || typeof raw.roomId !== "string") return null;
  return { dir, origin: raw.origin, roomId: raw.roomId, token: raw.token };
}

export async function unreadMentions(conn, fetchImpl = fetch) {
  const url = new URL(`/api/rooms/${encodeURIComponent(conn.roomId)}/mentions`, conn.origin);
  url.searchParams.set("state", "delivered");
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${conn.token}`, accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`mentions_unreadable_${response.status}`);
  const body = await response.json();
  return Array.isArray(body.mentions) ? body.mentions.filter(row => row && typeof row.messageEventId === "string") : [];
}

export function loadSeen(dir) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, SEEN_FILE), "utf8"));
    return { ids: new Set(Array.isArray(raw.ids) ? raw.ids : []), blocks: Number.isInteger(raw.blocks) ? raw.blocks : 0 };
  } catch {
    return { ids: new Set(), blocks: 0 };
  }
}

export function saveSeen(dir, seen) {
  mkdirSync(dir, { recursive: true });
  const ids = [...seen.ids].slice(-MAX_SEEN);
  writeFileSync(join(dir, SEEN_FILE), JSON.stringify({ ids, blocks: seen.blocks }), { mode: 0o600 });
}

const listed = rows => rows.slice(0, MAX_LISTED).map(row => `${row.messageEventId} (${row.createdAt ?? "unknown time"})`).join(", ");

export function sessionStartText(conn, rows) {
  if (!rows.length) return `Project Room ${conn.roomId}: no unread @mentions.`;
  const more = rows.length > MAX_LISTED ? `, and ${rows.length - MAX_LISTED} more` : "";
  return `Project Room ${conn.roomId}: ${rows.length} unread @mention${rows.length === 1 ? "" : "s"}: ${listed(rows)}${more}. `
    + "Read them with room_read_messages and answer or acknowledge before starting other work.";
}

// Returns the hook JSON to print, or null to let the agent stop.
export function stopDecision(conn, rows, seen, input = {}) {
  const fresh = rows.filter(row => !seen.ids.has(row.messageEventId));
  if (!fresh.length) {
    seen.blocks = 0;
    return null;
  }
  for (const row of fresh) seen.ids.add(row.messageEventId);
  if (input.stop_hook_active && seen.blocks >= MAX_STOP_BLOCKS) return null;
  seen.blocks += 1;
  return {
    decision: "block",
    reason: `Project Room ${conn.roomId}: ${fresh.length} new @mention${fresh.length === 1 ? "" : "s"} since you last checked: ${listed(fresh)}. `
      + "Read them with room_read_messages, reply or acknowledge in the room, then continue the work.",
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try { return text.trim() ? JSON.parse(text) : {}; } catch { return {}; }
}

export function stateDir(env, conn) {
  for (const key of ["PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"]) {
    if (typeof env[key] === "string" && env[key].trim()) return env[key].trim();
  }
  return conn.dir;
}

export async function main(mode, { env = process.env, fetchImpl = fetch, input = {}, out = s => process.stdout.write(s) } = {}) {
  let conn;
  try { conn = readConnection(env); } catch { conn = null; }
  if (!conn) {
    if (mode === "session-start") out("Project Room: set ROOM_AGENT_CONFIG to a private connection directory, then run node scripts/grok-room-host.mjs doctor\n");
    return 0;
  }
  try {
    const rows = await unreadMentions(conn, fetchImpl);
    const dir = stateDir(env, conn);
    const seen = loadSeen(dir);
    if (mode === "session-start") {
      for (const row of rows) seen.ids.add(row.messageEventId);
      seen.blocks = 0;
      saveSeen(dir, seen);
      out(`${sessionStartText(conn, rows)}\n`);
    } else if (mode === "stop") {
      const decision = stopDecision(conn, rows, seen, input);
      saveSeen(dir, seen);
      if (decision) out(`${JSON.stringify(decision)}\n`);
    }
  } catch {
    if (mode === "session-start") out(`Project Room ${conn.roomId}: mentions could not be read right now.\n`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const mode = process.argv[2];
  const input = mode === "stop" ? await readStdin() : {};
  process.exitCode = await main(mode, { input });
}
