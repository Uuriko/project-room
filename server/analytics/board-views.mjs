// Board-view facts for the activation funnel (#3588).
//
// Until this module, every board door served its read and discarded the
// claimable count it had just computed, so AN-FUNNEL-2's "saw board" stage
// (server/analytics/loop-funnel.mjs) was unmeasurable. The doors now call
// recordBoardView exactly once per served board view:
//
//   - public board list / match   (server/http.mjs, ui + rest doors)
//   - MCP public_work_recommend    (server/mcp-public-work.mjs, mcp door)
//   - in-room work-claims list     (server/work-claim-routes.mjs, ui + rest)
//
// A fact carries only the actor id (or anonymous), the door (as the
// analytics source), the scope (room id, or null for the public board),
// the claimable count the response carried, and the timestamp. No content,
// no task titles, no query text — the catalog forbids those prop keys and
// validateGrowthEvent is run before every insert.
//
// Recording is fail-soft by contract: a board read must never fail because
// analytics did. Any problem (no db, invalid input, a sqlite error) returns
// { written: false, reason } and the read proceeds untouched.
import { randomUUID } from "node:crypto";
import { growthEventId, sourceDetailFor, validateGrowthEvent } from "./catalog.mjs";
import { classifySource } from "./context.mjs";
import { ensureAnalyticsSchema, tableExists } from "./schema.mjs";

export const BOARD_VIEWED_EVENT = "board_viewed";
export const BOARD_VIEW_DOORS = Object.freeze(["ui", "rest", "mcp"]);
export const BOARD_VIEW_SCOPES = Object.freeze(["public", "room"]);

const INSERT = `INSERT OR IGNORE INTO analytics_events (
  id, name, v, at, room_id, account_id, actor_kind, actor_id, source, source_detail,
  agent_client, referrer_artifact_id, ref_member_id, loop, viewer_key, room_event_id,
  room_seq, props, weight, backfilled, exported_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`;

const isAgentId = id => typeof id === "string" && (id.startsWith("ai_") || id.startsWith("guest-agent-"));

// The door a board-serving HTTP request arrived through, in analytics
// source terms. classifySource separates cookie sessions (ui) from bearer
// callers (rest); anything else on a board route is a browser-shaped read
// with no credential, which is the ui door — an anonymous REST caller with
// no bearer is indistinguishable from one, and the funnel only needs the
// door, not the client.
export function boardDoorForRequest(req) {
  const source = classifySource(req);
  return source === "rest" || source === "mcp" ? source : "ui";
}

export function recordBoardView(db, { actorId = null, actorKind = null, door, roomId = null, scope, claimableCount, at } = {}) {
  try {
    if (!db || typeof db.prepare !== "function") return { written: false, reason: "no_db" };
    if (!BOARD_VIEW_DOORS.includes(door)) return { written: false, reason: "bad_door" };
    if (!BOARD_VIEW_SCOPES.includes(scope)) return { written: false, reason: "bad_scope" };
    if (scope === "room" && (typeof roomId !== "string" || !roomId)) return { written: false, reason: "bad_room" };
    if (!Number.isInteger(claimableCount) || claimableCount < 0) return { written: false, reason: "bad_claimable_count" };
    const identified = typeof actorId === "string" && actorId.length > 0;
    const kind = identified
      ? (actorKind === "human" || actorKind === "agent" ? actorKind : isAgentId(actorId) ? "agent" : "human")
      : "anonymous";
    const stamp = Number.isFinite(at) ? at : Date.now();
    const row = {
      name: BOARD_VIEWED_EVENT,
      v: 1,
      actor_kind: kind,
      source: door,
      loop: "organic",
      props: { claimable_count: claimableCount, scope }
    };
    const verdict = validateGrowthEvent(row);
    if (!verdict.ok) return { written: false, reason: "invalid", errors: verdict.errors };
    ensureAnalyticsSchema(db);
    const result = db.prepare(INSERT).run(
      growthEventId(randomUUID(), BOARD_VIEWED_EVENT, 0),
      BOARD_VIEWED_EVENT, 1, stamp,
      scope === "room" ? roomId : null,
      null, kind, identified ? actorId : null,
      door, sourceDetailFor(door), null, null, null, "organic", null, null, null,
      JSON.stringify(row.props), 1, 0
    );
    return { written: result.changes === 1 };
  } catch (error) {
    return { written: false, reason: "error", error: String(error?.message ?? error) };
  }
}

// The funnel's read side: every recorded board view, oldest first, in the
// shape loopFunnel consumes. A store with no board_viewed rows (or no
// analytics table yet) yields an empty list, never an error.
export function readBoardViews(db) {
  if (!db || typeof db.prepare !== "function" || !tableExists(db, "analytics_events")) return [];
  const rows = db.prepare(
    `SELECT actor_id AS actorId, room_id AS roomId, at,
            json_extract(props, '$.claimable_count') AS claimableCount
     FROM analytics_events WHERE name = ? ORDER BY at ASC`
  ).all(BOARD_VIEWED_EVENT);
  return rows
    .filter(row => Number.isFinite(row?.at))
    .map(row => ({
      actorId: typeof row.actorId === "string" ? row.actorId : null,
      roomId: typeof row.roomId === "string" ? row.roomId : null,
      claimableCount: Number.isFinite(row.claimableCount) ? row.claimableCount : null,
      at: row.at
    }));
}
