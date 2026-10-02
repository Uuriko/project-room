// Request context for growth events. AN-1c runs each request inside
// runWithRequestContext and registers an event hook that calls
// writeAnalyticsContext. Nothing in the request path calls this module yet.
import { AsyncLocalStorage } from "node:async_hooks";
import { isRoomMcpPath } from "../../src/room-mcp-join.js";
import { ensureAnalyticsSchema, tableExists } from "./schema.mjs";

const storage = new AsyncLocalStorage();

export const CONTEXT_MAX_ROWS = 50_000;
export const CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const COOKIES = ["room_session", "account_session"];

export function runWithRequestContext(ctx, fn) {
  return storage.run(ctx, fn);
}

export function currentRequestContext() {
  return storage.getStore() ?? null;
}

function header(req, name) {
  const headers = req?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) ?? "";
  const found = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
  return found ? String(headers[found] ?? "") : "";
}

function pathnameOf(req) {
  const raw = typeof req?.url === "string" ? req.url : req?.url?.pathname ?? "";
  if (!raw) return "";
  try {
    return new URL(raw, "http://localhost").pathname;
  } catch {
    return typeof raw === "string" && raw.startsWith("/") ? raw : "";
  }
}

function hasSessionCookie(req) {
  const cookie = header(req, "cookie");
  if (!cookie) return false;
  return COOKIES.some(name => new RegExp(`(?:^|;\\s*)${name}=`).test(cookie));
}

function hasBearer(req) {
  return /^bearer\s+\S/i.test(header(req, "authorization"));
}

// EVENTS.md §4. The first matching rule wins.
export function classifySource(req, auth = {}) {
  const path = pathnameOf(req);
  if (isRoomMcpPath(path)) return "mcp";
  if (path.startsWith("/api/inbound/") || path.startsWith("/api/webhooks/") || auth?.email === true) return "webhook";
  if (auth?.cron === true) return "cron";
  if (hasSessionCookie(req) || auth?.cookie === true) return "ui";
  if (hasBearer(req) || auth?.bearer === true) return "rest";
  return "unknown";
}

const CLIENTS = [
  ["claude", "claude-code"],
  ["codex", "codex"],
  ["cursor", "cursor"],
  ["devin", "devin"]
];

export function normalizeAgentClient(name) {
  if (typeof name !== "string" || !name.trim()) return null;
  const value = name.trim().toLowerCase();
  for (const [needle, canonical] of CLIENTS) {
    if (value.includes(needle)) return canonical;
  }
  return "other";
}

// AN-1c's event hook writes one row per room event. The tail joins on event_id.
// The spill stays bounded: rows older than a week, then the oldest past 50k.
export function writeAnalyticsContext(db, { eventId, source, agentClient, ref, at, maxRows = CONTEXT_MAX_ROWS, maxAgeMs = CONTEXT_MAX_AGE_MS } = {}) {
  if (typeof eventId !== "string" || !eventId) return { written: false };
  ensureAnalyticsSchema(db);
  const stamp = Number.isFinite(at) ? at : Date.now();
  db.prepare(`INSERT INTO analytics_ctx(event_id, source, agent_client, ref, at) VALUES(?,?,?,?,?)
    ON CONFLICT(event_id) DO NOTHING`).run(eventId, source ?? null, agentClient ?? null, ref ?? null, stamp);
  const cutoff = stamp - maxAgeMs;
  db.prepare("DELETE FROM analytics_ctx WHERE at < ?").run(cutoff);
  const count = db.prepare("SELECT count(*) AS n FROM analytics_ctx").get().n;
  if (count > maxRows) {
    db.prepare(`DELETE FROM analytics_ctx WHERE event_id IN (
      SELECT event_id FROM analytics_ctx ORDER BY at ASC, event_id ASC LIMIT ?
    )`).run(count - maxRows);
  }
  return { written: true };
}

export function readAnalyticsContext(db, eventId) {
  if (!tableExists(db, "analytics_ctx")) return null;
  return db.prepare("SELECT event_id, source, agent_client, ref, at FROM analytics_ctx WHERE event_id=?").get(eventId) ?? null;
}
