// server/routing-routes.mjs — affinity router HTTP surface, SHADOW MODE (lane B18).
//
// UNMOUNTED: this module is NOT wired into server/http.mjs (per lane brief and
// D6 §5.3 — shadow mode needs no flag beyond the shadow flag in
// routing-config.json). When a future lane mounts it, registration follows the
// createXRoutes factory pattern below.
//
// Endpoints:
//   POST /api/rooms/{roomId}/routing/suggest
//     body: { task: { title, brief?, files?[], tags?[], taskId?, issueUrl? },
//             topK?, reporter? }
//     → 200 { shadow: true, record } — the routing record is computed and
//       journaled to routing_records. SHADOW CONTRACT: no room post, no
//       routing.decided event, no inbox card, no claim interaction. The factory
//       receives only readBoardState + journal, so side effects are
//       structurally impossible.
//     → 409 { code: "routing_guard_veto" } when the guard vetoes (the record
//       is still journaled — silence is never an option).
//     → 422 invalid_routing_input (missing title).
//   GET /api/rooms/{roomId}/routing/history?taskId=…
//     → 200 { records: [...] } — audit trail for the eval loop.
//
// Journal table (additive, registered in writer-fence.mjs unfencedAdditiveTables):
//   routing_records(routing_id pk, room_id, task_id, shadow, board_fresh_at,
//                   record_json, created_at) — append-only, no UPDATE/DELETE.

import { decide, DEFAULT_CONFIG } from "./routing.mjs";

export const ROUTER_ROUTES_VERSION = "routing-routes/1.0";
export const SHADOW_MODE = true;

export const ROUTING_RECORDS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS routing_records (
    routing_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    task_id TEXT,
    shadow INTEGER NOT NULL DEFAULT 1,
    board_fresh_at TEXT,
    record_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_routing_records_task ON routing_records(task_id);
  CREATE INDEX IF NOT EXISTS idx_routing_records_room ON routing_records(room_id, created_at);
`;

class RoutingJournalError extends Error {
  constructor(code, message) { super(message); this.name = "RoutingJournalError"; this.code = code; }
}
export { RoutingJournalError };

// Append-only journal over any db with exec/prepare (node:sqlite DatabaseSync,
// or the RoomStore's db handle). Immutability by construction: this class has
// no update or delete methods.
export class RoutingJournal {
  constructor({ db }) {
    if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
      throw new RoutingJournalError("invalid_journal_db", "RoutingJournal needs a db with exec/prepare");
    }
    this.db = db;
  }
  record({ routingId, roomId, taskId = null, shadow = true, boardFreshAt = null, recordJson, createdAt = Date.now() }) {
    if (!routingId || !roomId || recordJson == null) {
      throw new RoutingJournalError("invalid_journal_entry", "routingId, roomId and recordJson are required");
    }
    try {
      this.db.prepare(
        `INSERT INTO routing_records (routing_id, room_id, task_id, shadow, board_fresh_at, record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(routingId, roomId, taskId, shadow ? 1 : 0, boardFreshAt, recordJson, createdAt);
    } catch (err) {
      throw new RoutingJournalError("duplicate_routing_id",
        `routing record ${routingId} is immutable — it was already journaled`);
    }
    return routingId;
  }
  get(routingId) {
    const row = this.db.prepare(`SELECT * FROM routing_records WHERE routing_id = ?`).get(routingId);
    return row ? this.#shape(row) : null;
  }
  listByTask(taskId, { limit = 50 } = {}) {
    return this.db.prepare(
      `SELECT * FROM routing_records WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(taskId, limit).map(r => this.#shape(r));
  }
  listByRoom(roomId, { limit = 100 } = {}) {
    return this.db.prepare(
      `SELECT * FROM routing_records WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(roomId, limit).map(r => this.#shape(r));
  }
  #shape(row) {
    return {
      routingId: row.routing_id,
      roomId: row.room_id,
      taskId: row.task_id,
      shadow: row.shadow === 1,
      boardFreshAt: row.board_fresh_at,
      recordJson: row.record_json,
      createdAt: row.created_at,
    };
  }
}

// Board reader contract (injected; the live implementation reads the
// work-claims board read-only via server/work-claims.mjs — a follow-up wiring
// lane's job, not this one):
//   readBoardState(roomId) → Promise<{
//     claims: [{ id, title?, state, owner?, files?[], tags?[], claimedAt?, completedAt? }],
//     freshAt: number, duplicates?: [{ id, of?, title? }] }>
// Lane candidates are derived from claim owners: open claims feed
// openClaims/load, done claims feed completedClaims/tags/titles.
const OPEN_STATES = new Set(["claimed", "in_progress", "blocked"]);

const lanesFromBoard = (claims, now, leaseWindowDays) => {
  const byLane = new Map();
  for (const c of claims ?? []) {
    const lane = c?.owner ?? c?.lane;
    if (typeof lane !== "string" || lane.length === 0) continue;
    if (!byLane.has(lane)) byLane.set(lane, { id: lane, openClaims: [], completedClaims: [], claimsWindow30d: [] });
    const L = byLane.get(lane);
    if (OPEN_STATES.has(c.state)) L.openClaims.push({ id: c.id, files: c.files ?? [] });
    if (c.state === "done") L.completedClaims.push({ id: c.id, title: c.title, files: c.files ?? [], tags: c.tags ?? [], completedAt: c.completedAt ?? null });
    const ts = c.claimedAt ?? c.completedAt;
    if (typeof ts === "number" && now - ts <= leaseWindowDays * 86_400_000) {
      L.claimsWindow30d.push({ id: c.id, state: c.state, claimedAt: ts });
    }
  }
  return [...byLane.values()];
};

export function createRoutingRoutes({
  json, reject, body, pathId,
  readBoardState, journal,
  config = DEFAULT_CONFIG,
  capabilities = { lanes: {} },
  authorize = null, // (req, roomId) → truthy member or throws; wiring lane supplies room auth
  now = () => Date.now(),
}) {
  if (typeof readBoardState !== "function") throw new Error("createRoutingRoutes needs readBoardState");
  if (!(journal instanceof RoutingJournal)) throw new Error("createRoutingRoutes needs a RoutingJournal");

  const authed = req => {
    if (authorize) return authorize(req);
    return { anonymous: true }; // shadow harness only; wiring lane passes real room auth
  };

  const handleSuggest = async (req, res, roomId) => {
    authed(req);
    const data = await body(req);
    const task = data?.task;
    if (!task || typeof task.title !== "string" || task.title.length === 0) {
      reject(422, "invalid_routing_input", "task.title is required");
    }
    const board = await readBoardState(roomId);
    const t = now();
    const lanes = lanesFromBoard(board.claims, t, config.decay.leaseWindowDays);
    const record = decide({
      workItem: task, lanes, boardState: board,
      ctx: { config, capabilities, now: t },
      now: t, roomId, topK: data.topK, reporter: data.reporter ?? null,
    });
    journal.record({
      routingId: record.routingId, roomId, taskId: record.workItem.taskId,
      shadow: record.shadow, boardFreshAt: record.boardFreshAt,
      recordJson: JSON.stringify(record), createdAt: t,
    });
    // SHADOW CONTRACT: the response IS the record. No room post, no
    // routing.decided event, no inbox mutation, no claim call — this factory
    // holds no handle to any of those surfaces.
    if (record.decision.action === "no_route") {
      return json(res, 409, { code: "routing_guard_veto", shadow: true, record });
    }
    return json(res, 200, { shadow: true, record });
  };

  const handleHistory = async (req, res, roomId, url) => {
    authed(req);
    const taskId = url.searchParams.get("taskId");
    if (!taskId) reject(422, "invalid_routing_input", "taskId query param is required");
    const records = journal.listByTask(taskId, { limit: 50 }).map(r => ({
      ...r, record: JSON.parse(r.recordJson),
    }));
    return json(res, 200, { records });
  };

  // Request-dispatch shape mirrors the other createXRoutes factories.
  return async function routingRoutes(req, res, { url }) {
    const m = /^\/api\/rooms\/([^/]+)\/routing\/(suggest|history)$/.exec(url.pathname);
    if (!m) return false;
    const roomId = pathId(m[1]);
    if (req.method === "POST" && m[2] === "suggest") { await handleSuggest(req, res, roomId); return true; }
    if (req.method === "GET" && m[2] === "history") { await handleHistory(req, res, roomId, url); return true; }
    return false;
  };
}
