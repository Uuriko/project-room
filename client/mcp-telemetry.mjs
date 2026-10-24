// TD-0 stdio side: the local MCP adapter has no server database, so its
// telemetry sink is a local SQLite store with the exact hosted table shape
// (server/analytics/mcp-telemetry.mjs) — the same mcpToolUsageReport reads
// it. Metadata only: tool name, caller class, outcome, timestamp. No
// arguments, no results, no credentials ever reach the sink
// (serveRoomMcp passes only the fields recordMcpTelemetry accepts).
//
// Wiring (scripts/agent-mcp.mjs): the sink is on when a path is derivable —
// ROOM_AGENT_TELEMETRY_PATH, or mcp-telemetry.sqlite inside the saved
// connection directory (ROOM_AGENT_CONFIG). ROOM_AGENT_TELEMETRY=0 turns
// it off. A sink that cannot open is simply absent: telemetry never fails
// a tool call.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  MCP_CALLER_CLASSES, MCP_TELEMETRY_SCHEMA, recordMcpTelemetry
} from "../server/analytics/mcp-telemetry.mjs";
import { API_KEY_PREFIX } from "../server/agent-api-keys.mjs";

export function openMcpTelemetrySink(path) {
  if (typeof path !== "string" || !path) return null;
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(MCP_TELEMETRY_SCHEMA);
  } catch {
    try { db?.close(); } catch { /* already closed */ }
    return null;
  }
  return Object.freeze({
    record: event => recordMcpTelemetry(db, { surface: "stdio", ...event }),
    close: () => { try { db.close(); } catch { /* already closed */ } }
  });
}

export function stdioTelemetryFromEnv(env = process.env, configDirectory = undefined) {
  if (env?.ROOM_AGENT_TELEMETRY === "0") return null;
  const path = typeof env?.ROOM_AGENT_TELEMETRY_PATH === "string" && env.ROOM_AGENT_TELEMETRY_PATH
    ? env.ROOM_AGENT_TELEMETRY_PATH
    : typeof configDirectory === "string" && configDirectory
      ? join(configDirectory, "mcp-telemetry.sqlite")
      : null;
  return path ? openMcpTelemetrySink(path) : null;
}

// The local adapter cannot resolve its saved credential to an identity id,
// so fleet membership is never guessed here either: an API key classifies
// itself by prefix; any other credential is external_identity unless the
// operator asserts a class explicitly (ROOM_AGENT_CALLER_CLASS) — Jill's
// fleet seats run with their identity id in ANALYTICS_LANE_ACTOR_IDS on the
// hosted surface, where the split is exact.
export function stdioCallerClass(token, asserted = undefined) {
  if (typeof asserted === "string" && MCP_CALLER_CLASSES.includes(asserted)) return asserted;
  if (typeof token === "string" && token.startsWith(API_KEY_PREFIX)) return "api_key";
  return "external_identity";
}
