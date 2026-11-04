// Per-call MCP log (Linear-parity measurement groundwork).
//
// One structured line per tools/call: tool name, outcome, error reason and
// latency. It never records arguments, results, bodies, room ids, identities
// or tokens — only the fields below. Off unless ROOM_MCP_CALL_LOG=1.
export const MCP_CALL_LOG_EVENT = "room.mcp_call";
const SAFE = /^[A-Za-z0-9_.:-]{1,64}$/;
const safe = value => (typeof value === "string" && SAFE.test(value) ? value : null);

export const mcpCallLogEnabled = (env = process.env) => env?.ROOM_MCP_CALL_LOG === "1";

// outcome: ok | tool_error (result.isError) | rpc_error (JSON-RPC error) | thrown
export function summarizeMcpCall(message, response, latencyMs, thrown = null) {
  const tool = safe(message?.params?.name) ?? "unknown";
  let outcome = "ok", reason = null;
  if (thrown) { outcome = "thrown"; reason = safe(thrown?.code) ?? safe(thrown?.name) ?? "error"; }
  else if (response?.error) { outcome = "rpc_error"; reason = safe(String(response.error.code ?? "")) ?? "rpc_error"; }
  else if (response?.result?.isError) {
    outcome = "tool_error";
    const sc = response.result.structuredContent ?? {};
    reason = safe(sc.reason) ?? safe(sc.code) ?? safe(sc.error?.code) ?? safe(sc.error) ?? "tool_error";
  }
  return { event: MCP_CALL_LOG_EVENT, tool, outcome, reason, ms: Math.max(0, Math.round(latencyMs * 10) / 10) };
}

// Wraps an MCP handler (message, ctx) => response. Non tools/call traffic and
// the disabled case pass straight through.
export function withMcpCallLog(handler, { env = process.env, sink = line => console.info(JSON.stringify(line)), clock = () => performance.now() } = {}) {
  return async function loggedMcp(message, ctx) {
    if (!mcpCallLogEnabled(env) || message?.method !== "tools/call") return handler(message, ctx);
    const started = clock();
    let response;
    try { response = await handler(message, ctx); }
    catch (error) { try { sink(summarizeMcpCall(message, null, clock() - started, error)); } catch { /* logging never breaks a call */ } throw error; }
    try { sink(summarizeMcpCall(message, response, clock() - started)); } catch { /* logging never breaks a call */ }
    return response;
  };
}
