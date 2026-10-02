// Weekly Productive Rooms and the baseline report.
// Every figure is counted from analytics rows and message.posted room events.
// Visits and billing are missing; this module does not fill them in.
import { closeNames } from "./map-room-event.mjs";
import { COMMONS_ROOM_ID, excludedRoomSet, structuralExclusion } from "./tail.mjs";
import { tableExists } from "./schema.mjs";

const ACTIVITY = new Set([
  "room_created", "invite_accepted", "agent_first_post",
  "claim_created", "claim_claimed", "pr_linked", "pr_merged", "claim_completed", "receipt_issued"
]);
const CLOSE = new Set(closeNames());
const DAY = 86400000;
const WEEK = 7 * DAY;

export function isoWeekStart(ms) {
  const date = new Date(ms);
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = new Date(utc).getUTCDay();
  const delta = day === 0 ? 6 : day - 1;
  return utc - delta * DAY;
}

export function weekLabel(ms) {
  return new Date(isoWeekStart(ms)).toISOString().slice(0, 10);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function roomExcluded(roomId, events, excludedRoomIds) {
  if (roomId === COMMONS_ROOM_ID || excludedRoomIds.has(roomId)) return true;
  if (structuralExclusion({ roomId })) return true;
  return events.some(event => event.props?.excluded === true);
}

export function weeklyProductiveRooms({ events, messages = [], now, weeks = 12, excludedRoomIds = new Set() }) {
  const end = isoWeekStart(now);
  const starts = [];
  for (let i = weeks - 1; i >= 0; i -= 1) starts.push(end - i * WEEK);
  const cells = new Map();
  const cell = (roomId, start) => {
    const key = `${roomId}\0${start}`;
    let row = cells.get(key);
    if (!row) {
      row = { human: false, agent: false, closed: false };
      cells.set(key, row);
    }
    return row;
  };
  const excludedRooms = new Set();
  for (const event of events) {
    if (!event.roomId || !Number.isFinite(event.at)) continue;
    if (roomExcluded(event.roomId, events.filter(item => item.roomId === event.roomId), excludedRoomIds)) {
      excludedRooms.add(event.roomId);
    }
  }
  const consider = (roomId, at, actorKind, closed) => {
    const start = isoWeekStart(at);
    if (!starts.includes(start)) return;
    const row = cell(roomId, start);
    if (actorKind === "human") row.human = true;
    if (actorKind === "agent") row.agent = true;
    if (closed) row.closed = true;
  };
  for (const event of events) {
    if (!event.roomId || !Number.isFinite(event.at)) continue;
    const closed = CLOSE.has(event.name);
    const active = ACTIVITY.has(event.name) || closed;
    if (!active && !closed) continue;
    consider(event.roomId, event.at, active ? event.actorKind : null, closed);
  }
  for (const message of messages) {
    if (!message.roomId || !Number.isFinite(message.at)) continue;
    consider(message.roomId, message.at, message.actorKind, false);
  }
  return starts.map(start => {
    let productiveRooms = 0;
    let productiveRoomsWithoutHumanRequirement = 0;
    let excludedProductiveRooms = 0;
    const seen = new Set();
    for (const [key, row] of cells) {
      const [roomId, stamp] = key.split("\0");
      if (Number(stamp) !== start || seen.has(roomId)) continue;
      seen.add(roomId);
      const full = row.human && row.agent && row.closed;
      const agentsOnly = row.agent && row.closed;
      if (excludedRooms.has(roomId)) {
        if (full) excludedProductiveRooms += 1;
        continue;
      }
      if (full) productiveRooms += 1;
      if (agentsOnly) productiveRoomsWithoutHumanRequirement += 1;
    }
    return {
      week: new Date(start).toISOString().slice(0, 10),
      productiveRooms,
      productiveRoomsWithoutHumanRequirement,
      excludedProductiveRooms
    };
  });
}

export function roomFunnel(events) {
  const rooms = new Map();
  for (const event of events) {
    if (!event.roomId || event.props?.excluded === true || event.roomId === COMMONS_ROOM_ID) continue;
    if (structuralExclusion({ roomId: event.roomId })) continue;
    let room = rooms.get(event.roomId);
    if (!room) {
      room = { created: null, agent: null, close: null };
      rooms.set(event.roomId, room);
    }
    if (event.name === "room_created" && (room.created == null || event.at < room.created)) room.created = event.at;
    if (event.name === "agent_connected" && (room.agent == null || event.at < room.agent)) room.agent = event.at;
    if (CLOSE.has(event.name) && (room.close == null || event.at < room.close)) room.close = event.at;
  }
  const byWeek = new Map();
  for (const room of rooms.values()) {
    if (room.created == null) continue;
    const week = weekLabel(room.created);
    let bucket = byWeek.get(week);
    if (!bucket) {
      bucket = { week, roomsCreated: 0, withAgent: 0, withClose: 0, hours: [] };
      byWeek.set(week, bucket);
    }
    bucket.roomsCreated += 1;
    if (room.agent != null) bucket.withAgent += 1;
    if (room.close != null) {
      bucket.withClose += 1;
      bucket.hours.push((room.close - room.created) / 3600000);
    }
  }
  return [...byWeek.values()].sort((a, b) => a.week < b.week ? -1 : 1).map(bucket => {
    const hours = bucket.hours.sort((a, b) => a - b);
    return {
      week: bucket.week,
      roomsCreated: bucket.roomsCreated,
      withAgent: bucket.withAgent,
      withClose: bucket.withClose,
      medianHoursToFirstClose: median(hours),
      p90HoursToFirstClose: percentile(hours, 90)
    };
  });
}

export function signupsByWeek(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.name !== "signup" || !Number.isFinite(event.at)) continue;
    const week = weekLabel(event.at);
    const origin = typeof event.props?.origin === "string" ? event.props.origin : "unknown";
    const key = `${week}\0${origin}`;
    groups.set(key, (groups.get(key) ?? 0) + (event.weight ?? 1));
  }
  return [...groups.entries()].map(([key, signups]) => {
    const [week, origin] = key.split("\0");
    return { week, origin, signups };
  }).sort((a, b) => a.week === b.week ? (a.origin < b.origin ? -1 : 1) : (a.week < b.week ? -1 : 1));
}

export function referralK(events) {
  const invites = events.filter(event => event.name === "referral_sent");
  const converted = events.filter(event => event.name === "referral_converted");
  const closes = new Map();
  for (const event of events) {
    if (!CLOSE.has(event.name) || !event.roomId || !Number.isFinite(event.at)) continue;
    const key = `${event.roomId}`;
    const prior = closes.get(key);
    if (prior == null || event.at < prior) closes.set(key, event.at);
  }
  const activatedReferees = converted.filter(event => {
    const closeAt = closes.get(event.roomId);
    return closeAt != null && closeAt >= event.at && closeAt - event.at <= 14 * DAY;
  }).length;
  const senderClosable = new Set();
  for (const invite of invites) {
    if (!invite.actorId) continue;
    const ownClose = events.find(event => CLOSE.has(event.name) && event.actorId === invite.actorId && Number.isFinite(event.at));
    if (ownClose && ownClose.at - invite.at <= 14 * DAY && invite.at - ownClose.at <= 14 * DAY) senderClosable.add(invite.actorId);
  }
  const invitesSent = invites.reduce((sum, event) => sum + (event.weight ?? 1), 0);
  const activatedSenders = senderClosable.size;
  const k = invitesSent > 0 && activatedSenders > 0 ? activatedReferees / activatedSenders : null;
  return {
    invitesSent,
    converted: converted.length,
    activatedWithin14Days: activatedReferees,
    activatedSenders,
    k
  };
}

function normalize(row) {
  const props = typeof row.props === "string" ? JSON.parse(row.props) : (row.props ?? {});
  return {
    name: row.name,
    at: row.at,
    roomId: row.room_id ?? row.roomId ?? null,
    actorKind: row.actor_kind ?? row.actorKind ?? null,
    actorId: row.actor_id ?? row.actorId ?? null,
    props,
    weight: row.weight ?? 1
  };
}

export function loadMessages(db) {
  if (!tableExists(db, "events")) return [];
  const kinds = new Map();
  for (const row of db.prepare(`SELECT room_id AS roomId, json_extract(body, '$.data.memberId') AS memberId, json_extract(body, '$.data.kind') AS kind
    FROM events WHERE json_extract(body, '$.type')='member.added'`).all()) {
    if (row.memberId && (row.kind === "human" || row.kind === "agent")) kinds.set(`${row.roomId}:${row.memberId}`, row.kind);
  }
  for (const row of db.prepare(`SELECT room_id AS roomId, json_extract(body, '$.data.memberId') AS memberId
    FROM events WHERE json_extract(body, '$.type')='member.joined_via_invitation'`).all()) {
    if (row.memberId) kinds.set(`${row.roomId}:${row.memberId}`, kinds.get(`${row.roomId}:${row.memberId}`) ?? "human");
  }
  const messages = [];
  for (const row of db.prepare(`SELECT room_id AS roomId, json_extract(body, '$.actorId') AS actorId, json_extract(body, '$.at') AS at
    FROM events WHERE json_extract(body, '$.type')='message.posted'`).all()) {
    const actorKind = kinds.get(`${row.roomId}:${row.actorId}`);
    const at = Date.parse(row.at ?? "");
    if ((actorKind === "human" || actorKind === "agent") && Number.isFinite(at)) {
      messages.push({ roomId: row.roomId, at, actorKind });
    }
  }
  return messages;
}

export function baselineReport(db, { now = Date.now(), env = process.env, messages } = {}) {
  const events = tableExists(db, "analytics_events")
    ? db.prepare("SELECT name, at, room_id, actor_kind, actor_id, props, weight FROM analytics_events").all().map(normalize)
    : [];
  const excludedRoomIds = excludedRoomSet(env);
  return {
    label: "backfilled; source unknown",
    missing: ["visits", "billing"],
    weeks: weeklyProductiveRooms({ events, messages: messages ?? loadMessages(db), now, excludedRoomIds }),
    funnel: roomFunnel(events),
    signups: signupsByWeek(events),
    referralK: referralK(events)
  };
}

// AN-1b reads this for /api/health/jobs. Counts only.
export function analyticsHealth(db, { now = Date.now(), exportConfigured = null } = {}) {
  if (!tableExists(db, "analytics_events")) {
    return {
      lastTailAt: null, rowsToday: 0, cursorLagRooms: null, unknownSourcePctToday: null,
      lastExportHour: null, exportConfigured, pruneBlocked: false
    };
  }
  const day = new Date(now).toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = start + DAY;
  const rowsToday = db.prepare("SELECT count(*) AS n FROM analytics_events WHERE at>=? AND at<?").get(start, end).n;
  const fresh = db.prepare("SELECT count(*) AS n FROM analytics_events WHERE at>=? AND at<? AND backfilled=0").get(start, end).n;
  const unknown = db.prepare("SELECT count(*) AS n FROM analytics_events WHERE at>=? AND at<? AND backfilled=0 AND source='unknown'").get(start, end).n;
  const lastTailAt = db.prepare("SELECT max(updated_at) AS at FROM analytics_room_cursor").get()?.at ?? null;
  const cursorLagRooms = tableExists(db, "rooms")
    ? db.prepare(`SELECT count(*) AS n FROM rooms r LEFT JOIN analytics_room_cursor c ON c.room_id=r.id
      WHERE r.sequence > COALESCE(c.last_seq, 0)`).get().n
    : null;
  const lastExportHour = db.prepare("SELECT value FROM analytics_daily WHERE metric='last_export_hour' ORDER BY day DESC LIMIT 1").get()?.value ?? null;
  const pruneBlocked = (db.prepare("SELECT value FROM analytics_daily WHERE day=? AND metric='prune_blocked_unexported'").get(day)?.value ?? 0) > 0;
  return {
    lastTailAt,
    rowsToday,
    cursorLagRooms,
    unknownSourcePctToday: fresh === 0 ? null : Math.round((unknown / fresh) * 1000) / 10,
    lastExportHour,
    exportConfigured,
    pruneBlocked
  };
}
