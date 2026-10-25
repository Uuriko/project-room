// Worker answer for MCP room_health. Parsed from a clone of the request so
// the original body stays available when this is not that call. A Durable
// Object that throws or times out still produces a tool result.

import { HEALTH_PROBE_TIMEOUT_MS } from "./health-probe.mjs";
import { isRoomHealthMcpCall, roomHealthMcpResponse, roomHealthReport } from "../server/room-health.mjs";

function within(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("room health timed out"), { timeout: true })), timeoutMs);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

export async function loadWorkerRoomHealth({ mode, deployment, emailVerification, probe, jobs }) {
  try {
    const result = await within(probe(), HEALTH_PROBE_TIMEOUT_MS);
    if (!result?.ok) {
      return roomHealthReport({ mode, deployment, emailVerification, degraded: true, doStatus: { status: "error" } });
    }
    let view = null;
    try {
      view = await within(jobs(), HEALTH_PROBE_TIMEOUT_MS);
    } catch {
      view = { schema: "room.job-health/1", status: "unavailable", jobs: [] };
    }
    return roomHealthReport({
      mode,
      deployment,
      emailVerification,
      doStatus: { status: "ok" },
      jobs: view,
      writerPermitResets: view?.writerPermitResets ?? { count: 0, lastResetAt: null }
    });
  } catch (error) {
    const timeout = error?.timeout === true;
    return roomHealthReport({
      mode,
      deployment,
      emailVerification,
      degraded: true,
      doStatus: timeout ? { status: "timeout", timeoutMs: HEALTH_PROBE_TIMEOUT_MS } : { status: "error" }
    });
  }
}

export async function maybeRoomHealthMcp(request, load) {
  if (request.method !== "POST") return null;
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/mcp" && pathname !== "/room/mcp") return null;
  let message;
  try { message = await request.clone().json(); } catch { return null; }
  if (!isRoomHealthMcpCall(message)) return null;
  return roomHealthMcpResponse(message, await load());
}
