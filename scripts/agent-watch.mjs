import { setTimeout as sleep } from "node:timers/promises";
import { RoomAgentClient, RoomClientError } from "../client/room-agent.mjs";
import { AssignmentWatcher } from "../client/assignment-watcher.mjs";
import { WatchJournal, WatchError } from "../client/watch-journal.mjs";
import { agentConnectionFromEnvironment, ConnectionError } from "../client/agent-connection.mjs";

export const WATCH_HELP = `Read-only assignment watcher (Node 24.19+):
  node scripts/agent-inbox.mjs watch start PRIVATE_DIRECTORY [--once]
  node scripts/agent-inbox.mjs watch status PRIVATE_DIRECTORY
  node scripts/agent-inbox.mjs watch stop PRIVATE_DIRECTORY

Start: ROOM_AGENT_CONFIG for a saved agent connection, OR ROOM_AGENT_ORIGIN,
ROOM_AGENT_ROOM, ROOM_AGENT_TOKEN (optional ROOM_AGENT_MEMBER) in the environment.
Never mix saved and environment credentials. A pinned agent is checked first.
Use a dedicated private local directory (not shared or cloud-synchronised).
Foreground only. Ctrl-C or stop ends watching; no tasks or messages are started.
Start prints attention JSONL to stdout; health/errors go to stderr. Status/stop
print one local JSON result. --once checks once and writes at most 20 notices.
Restart resumes pending notices; duplicate IDs may replay after a crash.
Notifications are not permission to act. Fetch current scope before acting.
`;

export function writeJson(stream, value, signal, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new WatchError("stopped")); return; }
    let settled = false;
    const finish = error => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      // Leave the one-shot error listener until after destroy has emitted.
      if (!error) stream.removeListener("error", failed);
      error ? reject(error) : resolve();
    };
    const failed = () => finish(new WatchError("output_failed"));
    const aborted = () => { stream.destroy(); finish(new WatchError("stopped")); };
    const timer = setTimeout(() => { stream.destroy(); failed(); }, timeoutMs);
    stream.once("error", failed); signal?.addEventListener("abort", aborted, { once: true });
    try { stream.write(JSON.stringify(value) + "\n", error => error ? failed() : finish()); }
    catch { failed(); }
  });
}

export function retryDelay(error, failures, intervalMs = 10000) {
  const transient = error instanceof RoomClientError ? [408, 429].includes(error.status) || error.status >= 500
    : error instanceof TypeError || error.name === "TimeoutError";
  if (!transient || failures >= 6) return null;
  const delay = Math.max(Math.min(60000, intervalMs * 2 ** (failures - 1)), error.retryAfterMs ?? 0);
  // Do not retry sooner than a server requests, or sleep indefinitely.
  return delay <= 300000 ? delay : null;
}

export async function watchLoop(watcher, { once = false, intervalMs = 10000, report = async () => {}, wait = sleep } = {}) {
  let failures = 0, reported = null;
  const status = async state => {
    watcher.journal.health(state);
    if (state !== reported) { reported = state; await report({ type: "watch_status", state, notifyOnly: true }); }
  };
  await status("starting");
  while (!watcher.signal.aborted) {
    let delay = intervalMs;
    try {
      await watcher.tick(); failures = 0; await status("watching");
      if (once) break;
    } catch (error) {
      if (watcher.signal.aborted || error.code === "stopped") break;
      delay = retryDelay(error, ++failures, intervalMs);
      if (delay === null) throw error;
      await status("retrying");
    }
    try { await wait(delay, undefined, { signal: watcher.signal }); }
    catch (error) { if (!watcher.signal.aborted) throw error; }
  }
  await status("stopped");
}

const errorCode = error => {
  if (error instanceof WatchError) return error.code;
  if (error instanceof ConnectionError) return "invalid_connection";
  if (error instanceof RoomClientError) return [401, 403].includes(error.status) ? "access_ended" : "room_unavailable";
  if (error.code === "ENOENT") return "state_not_found";
  return "watch_failed";
};

export async function watchMain(args) {
  let journal, monitor, controller;
  const stop = () => controller?.abort();
  try {
    if (args.length === 1 && args[0] === "--help") { process.stdout.write(WATCH_HELP); return; }
    const [action, directory, flag] = args;
    if (!["start", "status", "stop"].includes(action) || !directory || directory.startsWith("--")
        || args.length > 3 || (flag !== undefined && (action !== "start" || flag !== "--once"))) throw new WatchError("usage_error");
    if (action !== "start") {
      journal = new WatchJournal(directory, { acquire: false });
      await writeJson(process.stdout, action === "status" ? journal.status() : journal.requestStop());
      return;
    }
    const config = agentConnectionFromEnvironment(), { origin, roomId } = config;
    const client = new RoomAgentClient(config);
    if (config.memberId) await client.checkConnection();
    journal = new WatchJournal(directory);
    controller = new AbortController();
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    let monitorError;
    monitor = setInterval(() => {
      try { if (journal.shouldStop()) stop(); }
      catch (error) { monitorError = error; stop(); }
    }, 250);
    const watcher = new AssignmentWatcher({ client, journal, origin, roomId, signal: controller.signal,
      emit: (notice, signal) => writeJson(process.stdout, notice, signal) });
    await watchLoop(watcher, { once: flag === "--once", report: value => writeJson(process.stderr, value) });
    if (monitorError) throw monitorError;
  } catch (error) {
    process.exitCode = 1;
    const code = errorCode(error);
    try { await writeJson(process.stderr, { type: "watch_error", code, message: "Watcher stopped. Check access or private state, then restart. Use watch --help for usage." }); }
    catch { /* A closed diagnostic stream must not lose or reset pending output. */ }
  } finally {
    clearInterval(monitor); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    journal?.close();
  }
}
