// room wake-me: schedule this agent's own next check in the room.
//   room wake-me 15m [--note <text>]     schedule (or move) the next check
//   room wake-me 15m --wait              schedule, then block until it is due
//   room wake-me                         show the next check ("next check in 12 min")
// The room shows the time to everyone; --wait is for loop-driven agents.
import { randomUUID } from "node:crypto";
import { bearerHeader } from "../auth.mjs";
import { edgeDoorApiPath } from "../../server/agent-discovery.mjs";
import { connection } from "./code.mjs";
import { parseWakeIn } from "../../src/self-wake.js";

export function parseWakeMeArgs(argv) {
  let when = null, note = null, wait = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--wait") { wait = true; continue; }
    if (argv[i] === "--note" && argv[i + 1] !== undefined) { note = argv[++i]; continue; }
    if (argv[i].startsWith("--") || when !== null) throw new Error("Use room wake-me [<15m|2h>] [--note <text>] [--wait]");
    when = argv[i];
  }
  if (when !== null && parseWakeIn(when) === null) throw new Error("Give a duration up to 7 days, for example 15m or 2h");
  if (wait && when === null) throw new Error("--wait needs a duration");
  return { when, note, wait };
}

async function call(conn, method, data, fetchImpl) {
  const url = conn.origin + edgeDoorApiPath(conn.origin, `/api/rooms/${encodeURIComponent(conn.roomId)}/self-wake`);
  const response = await fetchImpl(url, { method, redirect: "error",
    headers: { Authorization: bearerHeader(conn.secret), ...(data ? { "Content-Type": "application/json" } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status} ${body?.error?.code ?? "error"}: ${body?.error?.message ?? "request failed"}`);
  return body;
}

export async function wakeMeCommand(argv, { env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch, out = console.log, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const { when, note, wait } = parseWakeMeArgs(argv);
  const conn = await connection({ env, cwd });
  if (when === null) {
    const view = await call(conn, "GET", null, fetchImpl);
    out(view.label ?? "No check scheduled.");
    return 0;
  }
  const view = await call(conn, "POST", { requestId: randomUUID(), in: when, ...(note ? { note } : {}) }, fetchImpl);
  out(`Scheduled: ${view.label}.`);
  if (!wait) return 0;
  while (now() < view.nextCheckAt) await sleep(Math.min(60000, view.nextCheckAt - now()));
  out(note ? `Time to check: ${note}` : "Time to check.");
  return 0;
}
