// Public opportunity feed (v2).
//
// Read-only discovery of open work across opt-in rooms. This is the safer
// successor to the reverted #857 feed: it is DECOUPLED FROM ADMISSION.
// Reading the feed grants nothing; acting on an opportunity uses the normal
// invite/join flow (single-use agent invites, share links, access requests).
// No invite codes, member lists, identity data, or admission URLs ever leave.
//
// Three explicit "help wanted" signals feed it:
//   1. work items carrying an open helpWanted invitation (WORK_HELP_UPDATED
//      with status "open" and a live expiry) on non-terminal work;
//   2. bounties in proposed/funded state with a live deadline;
//   3. unclaimed volunteer public-work tasks (#1609) — the opt-in pool is
//      public by design, so its tasks are discoverable without admission.
//
// Room-level discovery requires directory discoverability and an independent
// owner-controlled opportunity-feed flag. Existing listed rooms default to
// feed-on; an owner can hide work and bounties from the feed without unlisting
// the room or altering either underlying record. Archived rooms never appear.
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

// Listed, feed-enabled, non-archived rooms only.
function listedRoomIds(db, roomId) {
  if (roomId != null) {
    if (typeof roomId !== "string" || !roomId || roomId.length > 128) fail(422, "invalid_room", "room must be a room id");
    const row = db.prepare(`
        SELECT s.room_id AS roomId
        FROM room_directory_settings s
        JOIN rooms r ON r.id = s.room_id
        WHERE s.discoverable = 1 AND s.opportunities_enabled = 1 AND r.archived_at IS NULL AND s.room_id = ?`).get(roomId);
    return row ? [row.roomId] : [];
  }
  return db.prepare(`
      SELECT s.room_id AS roomId
      FROM room_directory_settings s
      JOIN rooms r ON r.id = s.room_id
      WHERE s.discoverable = 1 AND s.opportunities_enabled = 1 AND r.archived_at IS NULL
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

// Unclaimed volunteer public-work tasks are opt-in "help wanted" for
// strangers (#1609): the pool is public by design and its tasks already carry
// public packets (title, acceptance criteria, repository URL). Claimed and
// submitted tasks stay out; their owner/receipt material never reaches the
// feed. The room_id comes from the task row, not the packet, so the feed
// keeps its owner opt-in contract by restricting to the same listed,
// feed-enabled rooms as the other two signals.
function publicWorkOpportunity(task, roomId, roomTitle, openedAtMs) {
  const title = cleanText(task.title, 200);
  const repositoryUrl = cleanText(task.repositoryUrl, 300);
  if (!title || !repositoryUrl) return null;
  const acceptanceCriteria = Array.isArray(task.acceptanceCriteria)
    ? task.acceptanceCriteria.map(criterion => cleanText(criterion)).filter(Boolean)
    : [];
  return {
    kind: "public-work",
    taskId: task.taskId,
    roomId,
    roomTitle,
    roomPath: roomPath(roomId),
    title,
    acceptanceCriteria,
    repositoryUrl,
    claimState: "unclaimed",
    openedAt: new Date(openedAtMs).toISOString(),
  };
}

// Pages the public-work pool and returns the feed items for unclaimed tasks
// in the given listed rooms. Read-only: SELECTs plus the service's own list()
// cursor; no new tables, no migrations.
function publicWorkOpportunities(store, listedRoomIds, titles) {
  const service = store?.publicWorkClaims;
  if (!service || typeof service.list !== "function") return [];
  const tasks = [];
  let after = "";
  for (;;) {
    const page = service.list({ limit: 100, after });
    tasks.push(...page.tasks);
    if (!page.nextCursor) break;
    after = page.nextCursor;
  }
  if (!tasks.length) return [];
  const ids = tasks.map(task => task.taskId);
  const meta = new Map(store.db.prepare(
    `SELECT offer_id, room_id, created_at FROM public_work_tasks WHERE offer_id IN (${ids.map(() => "?").join(",")})`
  ).all(...ids).map(row => [row.offer_id, row]));
  const listed = new Set(listedRoomIds);
  const items = [];
  for (const task of tasks) {
    if (task?.claim?.state !== "unclaimed") continue;
    const row = meta.get(task.taskId);
    if (!row || !listed.has(row.room_id)) continue;
    const roomTitle = titles.get(row.room_id);
    if (!roomTitle) continue;
    const opp = publicWorkOpportunity(task, row.room_id, roomTitle, row.created_at);
    if (opp) items.push(opp);
  }
  return items;
}

const itemTs = opp => Date.parse(opp.kind === "bounty" ? opp.createdAt : opp.openedAt) || 0;

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
    // One deadline bind, then filter to listed rooms. An IN list binds one
    // variable per room; Durable Object SQL allows 100 binds and the public
    // directory is not capped at 99 rooms.
    const listed = new Set(roomIds);
    const bountyRows = db.prepare(`
        SELECT bounty_id, room_id, title, criteria, amount_millis, state, deadline_ms, label, created_at
        FROM bounty_records
        WHERE state IN ('proposed','funded')
          AND deadline_ms > ?`).all(now).filter(row => listed.has(row.room_id));
    for (const row of bountyRows) {
      const roomTitle = titles.get(row.room_id);
      if (!roomTitle) continue;
      const opp = bountyOpportunity(row, roomTitle);
      if (opp) opportunities.push(opp);
    }
    // Third signal: unclaimed volunteer public-work tasks (#1609).
    opportunities.push(...publicWorkOpportunities(store, roomIds, titles));
  }

  opportunities.sort((a, b) => itemTs(b) - itemTs(a));

  // Cheap resume: with ?since=, return only items opened/created after the
  // cursor. Items with no parseable timestamp are treated as ancient — they
  // cannot prove they are new, so a delta poll must not surface them.
  const visible = sinceMs == null ? opportunities : opportunities.filter(opp => itemTs(opp) > sinceMs);

  return {
    generatedAt: new Date(now).toISOString(),
    // Stable signpost so strangers always learn the volunteer pool's door,
    // even when every signal is dry (#1609).
    seeAlso: { publicWork: "/api/public-work/tasks" },
    opportunities: visible.slice(0, pageSize),
  };
}
