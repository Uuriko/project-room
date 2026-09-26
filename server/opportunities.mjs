// Public opportunity feed (v2).
//
// Read-only discovery of open work across opt-in rooms. This is the safer
// successor to the reverted #857 feed: it is DECOUPLED FROM ADMISSION.
// Reading the feed grants nothing; acting on an opportunity uses the normal
// invite/join flow (single-use agent invites, share links, access requests).
// No invite codes, member lists, identity data, or admission URLs ever leave.
//
// Two explicit "help wanted" signals feed it:
//   1. work items carrying an open helpWanted invitation (WORK_HELP_UPDATED
//      with status "open" and a live expiry) on non-terminal work;
//   2. bounties in proposed/funded state with a live deadline.
//
// Room-level opt-in reuses the #605 public directory: only rooms their owner
// flagged discoverable appear, and archived rooms never do. Posting work or
// funding a bounty in a listed room is itself the opt-in for that item —
// there is no separate feed toggle to forget.
//
// Sanitization is a strict field-by-field rebuild — never a passthrough.
// The module takes the RoomStore (db handle) and is shaped like
// RoomDirectory: no new tables, no migrations.
//
// Research design inputs (agent-attachment-proactivity-2026-09-24),
// folded in as constraints on this feed — not new workstreams:
//   1. Quest log (proactivity UI): feed items are self-selection-ready —
//      stable workItemId/bountyId keys and claim-ready blocks (title,
//      acceptance criteria, budget, deadline, scope) — so a per-agent quest
//      board of self-selected commitments can build directly on this feed.
//      The board itself (per-agent state, weekly featured tasks) is a
//      follow-on consumer, not this endpoint.
//   2. Cheap resume: ?since=<cursor> (ISO timestamp or ms) returns only
//      items opened/created after the cursor; generatedAt is the cursor for
//      the next poll. Agents catch up on deltas, never rebuilds. The fuller
//      GET /events?since=<cursor> typed-event delta feed is a separate
//      follow-on; ROOM-STATE.md stays the human-legible layer.
//   3. NL->typed conversion ramp: the item schema below IS the claim-ready
//      task block contract — a prose->task bot's output (title, acceptance
//      criteria, budget, deadline, scope, labels) maps 1:1 onto these
//      fields, so converted tasks land in the feed with no translation.
//   4. First-task experience: work-item `labels` slugs are surfaced so
//      clients can filter newcomer-safe tasks (e.g. label "newcomer-safe").
//      Fast, kind first review and rejection-reason-with-fix-path are
//      reviewer process norms, not feed code.
//   5. Explicitly never (manipulation line): no streaks, guilt pushes,
//      FOMO exclusives, variable-ratio surprise rewards, rewards on raw
//      counts, or public leaderboards — in this feed or around it. Sort is
//      recency-only, never popularity/engagement; comparison stays private
//      (percentiles, never public ranks).

class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const OPPORTUNITIES_DEFAULT_LIMIT = 50;
export const OPPORTUNITIES_MAX_LIMIT = 100;
const MAX_TEXT_CHARS = 500;

const cleanText = (value, max = MAX_TEXT_CHARS) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

const LABEL_RE = /^[a-z0-9-]{1,32}$/;

// Work-item labels are validated slugs at write time; filter defensively
// anyway so a bad projection row can never smuggle text into the feed.
const cleanLabels = value => {
  if (!Array.isArray(value)) return null;
  const slugs = value.filter(l => typeof l === "string" && LABEL_RE.test(l)).slice(0, 10);
  return slugs.length ? slugs : null;
};

// Cheap-resume cursor: ISO timestamp or epoch ms. Anything else is a 422 —
// a silent mis-parse would drop items the agent has never seen.
const parseSince = value => {
  if (value == null || value === "") return null;
  let ms = Number(value);
  if (!Number.isFinite(ms)) ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) fail(422, "invalid_since", "since must be an ISO timestamp or milliseconds");
  return ms;
};

const TERMINAL_WORK_STATES = new Set(["completed", "superseded"]);

// Rooms whose owner opted into public discovery and which are not archived.
function listedRoomIds(db, roomId) {
  if (roomId != null) {
    if (typeof roomId !== "string" || !roomId || roomId.length > 128) fail(422, "invalid_room", "room must be a room id");
    const row = db.prepare(`
        SELECT s.room_id AS roomId
        FROM room_directory_settings s
        JOIN rooms r ON r.id = s.room_id
        WHERE s.discoverable = 1 AND r.archived_at IS NULL AND s.room_id = ?`).get(roomId);
    return row ? [row.roomId] : [];
  }
  return db.prepare(`
      SELECT s.room_id AS roomId
      FROM room_directory_settings s
      JOIN rooms r ON r.id = s.room_id
      WHERE s.discoverable = 1 AND r.archived_at IS NULL
      ORDER BY s.room_id ASC`).all().map(r => r.roomId);
}

function roomProjection(db, roomId) {
  const row = db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  if (!row?.projection) return null;
  try {
    const projection = JSON.parse(row.projection);
    if (!projection || typeof projection !== "object") return null;
    return projection;
  } catch {
    return null;
  }
}

const roomPath = roomId => `/?room=${encodeURIComponent(roomId)}`;

function helpWantedOpportunity(item, roomId, roomTitle, now) {
  const help = item?.helpWanted;
  if (!help || help.status !== "open") return null;
  const expiresAt = Date.parse(help.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  if (TERMINAL_WORK_STATES.has(item.state)) return null;
  const title = cleanText(item.title, 200);
  if (!title) return null;
  return {
    kind: "help-wanted",
    workItemId: item.id,
    roomId,
    roomTitle,
    roomPath: roomPath(roomId),
    title,
    definitionOfDone: cleanText(item.definitionOfDone),
    helpScope: cleanText(help.scope),
    helpExpiresAt: help.expiresAt,
    workState: item.state,
    mode: item.mode ?? null,
    openedAt: help.openedAt,
    labels: cleanLabels(item.labels),
  };
}

function bountyOpportunity(row, roomTitle) {
  const title = cleanText(row.title, 200);
  if (!title) return null;
  return {
    kind: "bounty",
    bountyId: row.bounty_id,
    roomId: row.room_id,
    roomTitle,
    roomPath: roomPath(row.room_id),
    title,
    criteria: cleanText(row.criteria),
    amountMillis: row.amount_millis,
    state: row.state,
    deadlineMs: row.deadline_ms,
    label: cleanText(row.label, 120),
    createdAt: row.created_at,
  };
}

export function buildOpportunitiesFeed(store, { now = Date.now(), roomId = null, limit = null, since = null } = {}) {
  const db = store?.db;
  if (!db) fail(500, "opportunities_store_missing", "Opportunity feed requires a store with a db handle");
  const n = limit == null || limit === "" ? NaN : Number(limit);
  const pageSize = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), OPPORTUNITIES_MAX_LIMIT) : OPPORTUNITIES_DEFAULT_LIMIT;
  const sinceMs = parseSince(since);

  const roomIds = listedRoomIds(db, roomId);
  const opportunities = [];
  // The feed needs both work and bounty titles. Parse each listed room once
  // rather than reading and JSON-parsing its projection again for bounties.
  const titles = new Map();

  for (const id of roomIds) {
    const projection = roomProjection(db, id);
    if (!projection) continue; // silently skip unusable rooms, like the directory listing
    const roomTitle = cleanText(projection?.room?.title, 200);
    if (!roomTitle) continue;
    titles.set(id, roomTitle);
    const workItems = projection.workItems && typeof projection.workItems === "object" ? Object.values(projection.workItems) : [];
    for (const item of workItems) {
      if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
      const opp = helpWantedOpportunity(item, id, roomTitle, now);
      if (opp) opportunities.push(opp);
    }
  }

  if (roomIds.length) {
    const placeholders = roomIds.map(() => "?").join(",");
    const bountyRows = db.prepare(`
        SELECT bounty_id, room_id, title, criteria, amount_millis, state, deadline_ms, label, created_at
        FROM bounty_records
        WHERE room_id IN (${placeholders})
          AND state IN ('proposed','funded')
          AND deadline_ms > ?`).all(...roomIds, now);
    for (const row of bountyRows) {
      const roomTitle = titles.get(row.room_id);
      if (!roomTitle) continue;
      const opp = bountyOpportunity(row, roomTitle);
      if (opp) opportunities.push(opp);
    }
  }

  opportunities.sort((a, b) => {
    const at = Date.parse(a.kind === "bounty" ? a.createdAt : a.openedAt) || 0;
    const bt = Date.parse(b.kind === "bounty" ? b.createdAt : b.openedAt) || 0;
    return bt - at;
  });

  // Cheap resume: with ?since=, return only items opened/created after the
  // cursor. Items with no parseable timestamp are treated as ancient — they
  // cannot prove they are new, so a delta poll must not surface them.
  const visible = sinceMs == null ? opportunities : opportunities.filter(opp => {
    const ts = Date.parse(opp.kind === "bounty" ? opp.createdAt : opp.openedAt) || 0;
    return ts > sinceMs;
  });

  return {
    generatedAt: new Date(now).toISOString(),
    opportunities: visible.slice(0, pageSize),
  };
}
