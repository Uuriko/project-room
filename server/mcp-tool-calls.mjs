// MCP per-tool call counter (deep-pass T0 usage-reads, Read 2).
//
// Before this module no per-tool MCP figure existed anywhere: the hosted
// dispatch recorded nothing per call, and the room.request log line carries
// only the path (every hosted call is POST /mcp), so tool usage could never
// be graded from logs. This counter is the instrument that starts the
// 30-day per-tool clock: one row per (day, tool), incremented once per
// tools/call dispatch at the two dispatch points named by the T0 spec —
// callRoomTool in server/mcp-room-profile.mjs (hosted room tools, including
// the inner dispatch of a room_run_action recursion) and the anonymous
// join-tool branch in server/mcp-http.mjs (handleMcpJoinRpc, reached via
// dispatchRoomMcp or threaded with an onToolCall recorder).
//
// Rows carry a day, a tool name, and call/error counts only — never
// arguments, results, identities, or rooms. The table is lazy/additive
// (created on first counted call) and registered in
// server/writer-fence.mjs lazyAdditiveTables, with a retain row in
// server/purge-registry.mjs. The read surface is the operator route
// GET /api/operator/mcp-tool-calls (server/operator-routes.mjs), so the
// figures are production-readable without a store file.

export const MCP_TOOL_CALLS_TABLES = Object.freeze(["mcp_tool_calls"]);

export const mcpToolCallsSchema = `
  CREATE TABLE IF NOT EXISTS mcp_tool_calls (
    day TEXT, tool TEXT, calls INTEGER, errors INTEGER,
    PRIMARY KEY(day, tool)
  );
`;

const ensured = new WeakSet();
export function ensureMcpToolCallsSchema(db) {
  if (!db || ensured.has(db)) return false;
  db.exec(mcpToolCallsSchema);
  ensured.add(db);
  return true;
}

const hasTable = (db) => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_tool_calls'").get());

// Recovery-audit partitioning for a lazy sidecar: a store that never
// counted a call has no table (tolerated); a present table must carry the
// exact columns of the counter.
export function verifyMcpToolCallsSchema(db, { allowAbsent = false } = {}) {
  if (!hasTable(db)) {
    if (allowAbsent) return { present: false };
    throw new Error("mcp_tool_calls table is missing");
  }
  const columns = db.prepare("PRAGMA table_info(mcp_tool_calls)").all().map(row => row.name);
  const expected = ["day", "tool", "calls", "errors"];
  if (JSON.stringify(columns) !== JSON.stringify(expected)) {
    throw new Error(`mcp_tool_calls columns differ: ${columns.join(",")}`);
  }
  return { present: true };
}

// Record one dispatched tools/call. Never throws: counting rides the MCP
// dispatch path and must not be able to fail a tool call. (Tests pin that
// counters DO move on every real dispatch path, so a silent no-op here
// cannot hide.) `at` is epoch ms; the day bucket is its UTC calendar day.
// Returns true when recorded.
export function recordMcpToolCall(db, tool, { isError = false, at = Date.now() } = {}) {
  try {
    if (!db || typeof tool !== "string" || tool.length === 0 || tool.length > 128) return false;
    if (!Number.isFinite(at)) return false;
    ensureMcpToolCallsSchema(db);
    const day = new Date(at).toISOString().slice(0, 10);
    db.prepare(`INSERT INTO mcp_tool_calls (day, tool, calls, errors) VALUES (?, ?, 1, ?)
      ON CONFLICT(day, tool) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors`)
      .run(day, tool, isError ? 1 : 0);
    return true;
  } catch {
    return false;
  }
}

// Read the counter back: rows for one day, or every day on file when no
// day is given, ordered for a stable operator/export view. Safe on a
// pre-counter database (no table yet reads as no rows).
export function listMcpToolCalls(db, { day = null } = {}) {
  if (!db || !hasTable(db)) return [];
  const rows = day
    ? db.prepare("SELECT day, tool, calls, errors FROM mcp_tool_calls WHERE day=? ORDER BY tool").all(day)
    : db.prepare("SELECT day, tool, calls, errors FROM mcp_tool_calls ORDER BY day, tool").all();
  return rows.map(row => ({ day: row.day, tool: row.tool, calls: row.calls, errors: row.errors }));
}
