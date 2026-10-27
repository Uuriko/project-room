// FUNNEL-COUNT-1 (Option B descope): the public door funnel instrument.
//
// What this counts, and what it deliberately does not:
//
// The door's working steps split across two serving boundaries. In
// production, /, /offers and /llms.txt are answered by the Cloudflare
// Worker isolate (cloudflare/edge-public.mjs) before the request ever
// reaches the Durable Object that owns this store, and no edge-to-DO
// ingest pattern exists. This module therefore counts ONLY arrivals at
// the Node boundary: views of the Node-served public surfaces, auth
// starts by method (including the not-configured outcome), and the
// read-time derivations (joins, identity mints, auth completions) the
// store already holds. The readout's own surfaces table records every
// surface with counted:true/false; an uncounted surface renders null
// views, never a silent zero. The pre-registered decision rule was
// amended in writing before this code landed (the amendment ships with
// the charter): the TRAFFIC/DOOR split is decided on Node-boundary
// arrivals only, and a TRAFFIC verdict from this instrument means "no
// arrivals at the Node boundary", never "nobody saw the landing".
//
// Write-side contract (the analytics tail's own precedent): a counter
// failure must never break the request that carried it, so both record
// functions swallow their errors. Read-side contract (the C5-2 birth
// checklist): a source failure refuses the whole read with a named
// error — one leg never silently zeroes.
import { ensureAnalyticsSchema, addDaily, utcDay, tableExists } from "./schema.mjs";
import { isoWeekStart } from "./metrics.mjs";
import { AI_CRAWLERS } from "../agent-discovery.mjs";

export const DOOR_FUNNEL_MAX_WEEKS = 12;

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

// The full public-surface table. `counted` describes what THIS
// instrument counts, in any deployment: the classifier below never
// counts the three edge-served surfaces, so the flag is honest
// everywhere, not a deployment guess.
export const DOOR_FUNNEL_SURFACES = Object.freeze([
  Object.freeze({ surface: "landing", path: "/", counted: false, servedBy: "edge" }),
  Object.freeze({ surface: "offers", path: "/offers", counted: false, servedBy: "edge" }),
  Object.freeze({ surface: "llms_txt", path: "/llms.txt", counted: false, servedBy: "edge" }),
  Object.freeze({ surface: "receipts", path: "/receipts", counted: true, servedBy: "node" }),
  Object.freeze({ surface: "receipt_detail", path: "/receipts/<id>", counted: true, servedBy: "node" }),
  Object.freeze({ surface: "join", path: "/join", counted: true, servedBy: "node" }),
  Object.freeze({ surface: "agent_skills", path: "/.well-known/agent-skills/*", counted: true, servedBy: "node" }),
]);

const COUNTED_SURFACES = DOOR_FUNNEL_SURFACES.filter(entry => entry.counted).map(entry => entry.surface);
const UNCOUNTED_SURFACES = DOOR_FUNNEL_SURFACES.filter(entry => !entry.counted).map(entry => entry.surface);

// The receipt-detail id shapes, mirroring the public receipts route.
const RECEIPT_DETAIL_PATH = /^\/receipts\/(?:pwr_[a-f0-9]{16,128}|wcr_[a-f0-9]{32}|wir_[a-f0-9]{32}|lot_[a-f0-9]{16})(?:\.json)?$/;

export function classifyDoorFunnelSurface(pathname) {
  if (typeof pathname !== "string") return null;
  if (pathname === "/receipts") return "receipts";
  if (RECEIPT_DETAIL_PATH.test(pathname)) return "receipt_detail";
  if (pathname === "/join") return "join";
  if (pathname === "/.well-known/agent-skills" || pathname.startsWith("/.well-known/agent-skills/")) return "agent_skills";
  return null;
}

// The catalog declares only an is_bot flag, no user-agent list; the
// repo's one UA list is agent-discovery's crawler policy. Bots are
// counted in their own leg (viewbot:*) so the headline view count stays
// the total and the bot share stays visible, never silently excluded.
const GENERIC_BOT_TOKENS = /(?:bot|crawler|spider|slurp|headless)/i;

export function isDoorFunnelBot(userAgent) {
  if (typeof userAgent !== "string" || !userAgent) return false;
  const lowered = userAgent.toLowerCase();
  return AI_CRAWLERS.some(name => lowered.includes(name.toLowerCase())) || GENERIC_BOT_TOKENS.test(userAgent);
}

const ensuredDbs = new WeakSet();

function ensure(db) {
  if (!ensuredDbs.has(db)) {
    ensureAnalyticsSchema(db);
    ensuredDbs.add(db);
  }
}

const atOrNow = now => (Number.isFinite(now) ? now : Date.now());

export function recordDoorFunnelView(db, { pathname, userAgent, now } = {}) {
  try {
    if (!db) return;
    const surface = classifyDoorFunnelSurface(pathname);
    if (!surface) return;
    ensure(db);
    const day = utcDay(atOrNow(now));
    addDaily(db, day, `view:${surface}`, 1);
    if (isDoorFunnelBot(userAgent)) addDaily(db, day, `viewbot:${surface}`, 1);
  } catch {
    // A counter failure must never break the public read that carried it.
  }
}

// leg "start": the start handler was entered for this method — an auth
// start is an arrival even when sign-in is not configured. leg
// "unavailable": the handler answered with its not-configured refusal.
export function recordDoorFunnelAuth(db, { method, leg, now } = {}) {
  try {
    if (!db || (method !== "google" && method !== "github")) return;
    if (leg !== "start" && leg !== "unavailable") return;
    ensure(db);
    addDaily(db, utcDay(atOrNow(now)), leg === "start" ? `auth_start:${method}` : `auth_unavailable:${method}`, 1);
  } catch {
    // Same contract as recordDoorFunnelView.
  }
}

function listedRoomIds(store) {
  const ids = [];
  let cursor = null;
  // The directory is the only source of the listed set (never a
  // hard-coded room list); page through it with a hard stop so a bad
  // cursor can never spin the read.
  for (let page = 0; page < 100; page += 1) {
    const result = store.roomDirectory.list({ after: cursor, limit: 100 });
    for (const room of result?.rooms ?? []) if (typeof room?.roomId === "string") ids.push(room.roomId);
    cursor = result?.nextCursor ?? null;
    if (!cursor) break;
  }
  return ids;
}

export function readDoorFunnel(store, { weeks, now } = {}) {
  const at = atOrNow(now);
  const requested = Number(weeks);
  const count = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), DOOR_FUNNEL_MAX_WEEKS)
    : DOOR_FUNNEL_MAX_WEEKS;
  const db = store.db;
  ensure(db);
  const lastStart = isoWeekStart(at);
  const starts = Array.from({ length: count }, (_, index) => lastStart - (count - 1 - index) * WEEK_MS);
  // Event bodies stamp their time as ISO-8601 text, not epoch ms, so
  // bucketing parses values rather than comparing them in SQL (a text
  // value compares greater than every integer in SQLite, which would
  // silently disable a numeric range filter).
  const weekIndex = value => {
    const ms = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(ms)) return -1;
    return Math.floor((isoWeekStart(ms) - starts[0]) / WEEK_MS);
  };
  const inWindow = index => index >= 0 && index < count;

  const buckets = starts.map(start => {
    const bucket = {
      startsAt: utcDay(start),
      joins: {},
      mints: 0,
      views: {},
      viewBots: {},
      auth: {
        starts: { google: 0, github: 0 },
        unavailable: { google: 0, github: 0 },
        completions: { google: 0, github: 0 },
      },
    };
    for (const surface of COUNTED_SURFACES) {
      bucket.views[surface] = 0;
      bucket.viewBots[surface] = 0;
    }
    for (const surface of UNCOUNTED_SURFACES) {
      bucket.views[surface] = null;
      bucket.viewBots[surface] = null;
    }
    return bucket;
  });

  const listed = listedRoomIds(store);
  for (const bucket of buckets) for (const roomId of listed) bucket.joins[roomId] = 0;

  // Daily counters for the window, bucketed by ISO week.
  const counterRows = db.prepare("SELECT day, metric, value FROM analytics_daily WHERE day >= ?").all(utcDay(starts[0]));
  for (const row of counterRows) {
    const index = weekIndex(Date.parse(`${row.day}T00:00:00Z`));
    if (!inWindow(index)) continue;
    const bucket = buckets[index];
    let match;
    if ((match = /^view:([a-z_]+)$/.exec(row.metric))) {
      if (bucket.views[match[1]] !== null && match[1] in bucket.views) bucket.views[match[1]] += row.value;
    } else if ((match = /^viewbot:([a-z_]+)$/.exec(row.metric))) {
      if (bucket.viewBots[match[1]] !== null && match[1] in bucket.viewBots) bucket.viewBots[match[1]] += row.value;
    } else if ((match = /^auth_start:(google|github)$/.exec(row.metric))) {
      bucket.auth.starts[match[1]] += row.value;
    } else if ((match = /^auth_unavailable:(google|github)$/.exec(row.metric))) {
      bucket.auth.unavailable[match[1]] += row.value;
    }
  }

  // Joins: the access review's own derivation — member-added events in
  // listed rooms, bucketed by the event's recorded time. The window
  // filter is the JS bucketing above, per the ISO-text note there.
  if (listed.length) {
    const placeholders = listed.map(() => "?").join(",");
    const joinRows = db.prepare(
      `SELECT room_id AS roomId, json_extract(body, '$.at') AS at FROM events
        WHERE room_id IN (${placeholders})
          AND json_extract(body, '$.type') IN ('member.added', 'member.joined_via_invitation')`,
    ).all(...listed);
    for (const row of joinRows) {
      const index = weekIndex(row.at);
      if (inWindow(index)) buckets[index].joins[row.roomId] += 1;
    }
  }

  // Mints: agent identities carry their mint time on the row.
  if (tableExists(db, "agent_identities")) {
    const mintRows = db.prepare("SELECT created_at AS at FROM agent_identities WHERE created_at >= ?").all(starts[0]);
    for (const row of mintRows) {
      const index = weekIndex(row.at);
      if (inWindow(index)) buckets[index].mints += 1;
    }
  }

  // Auth completions: an account row exists per completed sign-in,
  // stamped with its method in origin.
  if (tableExists(db, "accounts")) {
    const accountRows = db.prepare(
      "SELECT origin, created_at AS at FROM accounts WHERE created_at >= ? AND origin IN ('google-oauth', 'github-oauth')",
    ).all(starts[0]);
    for (const row of accountRows) {
      const index = weekIndex(row.at);
      if (inWindow(index)) buckets[index].auth.completions[row.origin === "google-oauth" ? "google" : "github"] += 1;
    }
  }

  return {
    generatedAt: new Date(at).toISOString(),
    surfaces: DOOR_FUNNEL_SURFACES,
    weeks: buckets,
  };
}
