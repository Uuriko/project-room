import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { RoomStore } from "./server/store.mjs";
import { stitchConfigFromEnv } from "./server/inbox-stitch.mjs";
import { createRoomServer } from "./server/http.mjs";
import { telegramConfig } from "./server/channel-adapters/telegram-config.mjs";
import { defaultServerArgs } from "./server/boot-options.mjs";
import { wireNodeJobs } from "./server/jobs.mjs";
import { deploymentConfig } from "./server/deployment.mjs";
import { createServer } from "node:http";
import { maintenanceEnabled, maintenanceReply } from "./server/maintenance.mjs";
import { SOURCE_REVISION, BUILD_ID } from "./server/version.mjs";
import { growthCollector } from "./src/growth-emit.js";
import { loadFromFile, saveToFile } from "./src/growth-persistence.js";
import { createGrowthHttp } from "./src/growth-http.js";
import { acquireInstanceLock } from "./server/instance-lock.mjs";
import { validateCriticalConfig } from "./server/boot-config.mjs";
import { agentCardSignatureState } from "./deploy/agent-discovery.mjs";

const { host, port, origin, filename, production, streamInterval } = deploymentConfig();
const paused = maintenanceEnabled(process.env.ROOM_MAINTENANCE);
process.umask(0o077);
let havePilotDb = false;
try { havePilotDb = statSync(filename).isFile(); }
catch (error) { if (error?.code !== "ENOENT") throw error; }
if (!paused && production && !havePilotDb) throw new Error("Provision a persistent pilot database before startup");
// Fail-loud config gate (RC-2026-09-27-2732): missing/invalid critical
// config throws a member-facing error naming the fix, never silently
// degrades. Runs before any side effect (locks, dirs, sockets). Dev-mode
// warnings go to stderr so the stdout "server ready" first line (C13) is
// untouched.
if (!paused) {
  const { warnings } = validateCriticalConfig({ production, cardSignature: agentCardSignatureState() });
  for (const warning of warnings) console.error(`[boot-config] ${warning}`);
}
if (!paused) mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
// Single-instance lock: one server process per database. SQLite serializes
// store writes, but the growth snapshot is a plain JSON file — a second
// process would race it (last-writer-wins / torn write on concurrent
// shutdown). Refusing to boot is the safe failure mode; override the path
// for tests via ROOM_INSTANCE_LOCK_PATH.
const lockPath = process.env.ROOM_INSTANCE_LOCK_PATH || join(dirname(filename), ".project-room.lock");
const instanceLock = paused ? null : acquireInstanceLock(lockPath);
let store = null;
try {
  store = paused ? null : new RoomStore(filename, { stitch: stitchConfigFromEnv(process.env) });
  if (store && production && !store.db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) { store.close(); store = null; throw new Error("Provision a room before deployment"); }
} catch (error) { instanceLock?.release(); throw error; }
// Event-push dispatch: after an event commit journals webhook deliveries,
// flush them fire-and-forget so the signed POSTs leave without waiting for
// the job tick (which stays the restart-safe backstop). The kick never
// blocks the request path — the drain runs on a microtask and failures
// stay in the durable retry queue. The same scheduler retries webhooks,
// polls the land queue and linked claims, and runs retention and integrity.
if (store) store.landQueue.configure({ env: process.env });
// Track C C13/C14 — growth scheduler state. Declared before the server is
// created so the C14 read-only HTTP surface can close over live status via
// a getter evaluated per request (the scheduler itself starts after listen).
let nodeJobs = null;
let growthIntervalMs = 0;
// Task 9 — channel drain scheduler state. Declared before the server is
// created so the listen callback can report its status (same as growth).
let channelDrainIntervalMs = 0;
// Track C C14 — read-only growth HTTP surface (GET /growth/summary,
// /growth/digest, /growth/health). Pure reads over the collector and the
// scheduler-status getter: no emission, no mutation, no timers. Null in
// paused (maintenance) mode, where the minimal handler takes over.
const growthHttp = paused ? null : createGrowthHttp({
  collector: growthCollector,
  getSchedulerStatus: () => nodeJobs?.growthEnabled
    ? { running: nodeJobs.isRunning(), tickCount: nodeJobs.getGrowthTickCount(), intervalMs: growthIntervalMs }
    : { running: false, tickCount: 0, intervalMs: growthIntervalMs }
});
const serverArgs = paused ? null : defaultServerArgs({ store, origin, streamInterval, trustedLocalProxy: production, telegram: telegramConfig(process.env), growth: growthHttp });
const server = paused ? createServer((req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.origin !== origin || req.headers.host !== new URL(origin).host) {
      res.writeHead(403, { "Cache-Control": "no-store" }); res.end(); return;
    }
    // REL-22: the release receipt stays readable while paused, like the
    // Workers /api/version/worker door. Module constants only: no storage,
    // no cookie, no store. Health, ready, reads and writes stay 503.
    if (url.pathname === "/api/version" && (req.method === "GET" || req.method === "HEAD")) {
      const body = JSON.stringify({ status: "paused", mode: "maintenance", sourceRevision: SOURCE_REVISION, buildId: BUILD_ID });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : body); return;
    }
    const reply = maintenanceReply(url.pathname);
    res.writeHead(reply.status, reply.headers); res.end(req.method === "HEAD" ? undefined : reply.body);
  } catch { res.writeHead(400, { "Cache-Control": "no-store" }); res.end(); }
}) : createRoomServer(serverArgs);
server.on('close', () => nodeJobs?.stop());
// Track C C11 — growth collector persistence. The snapshot lives in its own
// JSON file next to the store file; it never touches the store schema. Any
// failure here only costs analytics history, never boot or shutdown.
const growthSnapshotPath = process.env.GROWTH_SNAPSHOT_PATH || join(dirname(filename), "growth-snapshot.json");
if (!paused) {
  try {
    const { restored, collector, exportedAt } = loadFromFile(growthSnapshotPath);
    if (restored) {
      const stored = collector.query({ limit: collector.stats().capacity });
      let replayed = 0;
      for (const envelope of stored) {
        if (growthCollector.record(envelope).ok) replayed += 1;
      }
      console.log(`[growth] restored ${replayed} events from snapshot${exportedAt ? ` (${exportedAt})` : ""}`);
    }
  } catch (error) {
    console.warn(`[growth] snapshot restore skipped: ${error?.message ?? error}`);
  }
}
// (growthScheduler / growthIntervalMs are declared above, before server creation,
// so the C14 surface can close over them via a per-request status getter.)
server.listen(port, host, () => {
  console.log(`Project Room ${paused ? "paused" : production ? "invite-only pilot" : "local pilot"}: ${origin}`);
  // C13 readiness note: the listen line above must stay the first stdout write,
  // because packaging tests treat first stdout data as "server ready".
  if (!paused) console.log(nodeJobs?.growthEnabled && nodeJobs.isRunning()
    ? `[growth] scheduler started (tick every ${growthIntervalMs}ms)`
    : "[growth] scheduler disabled");
  if (!paused) console.log(nodeJobs?.channelEnabled && nodeJobs.isRunning()
    ? `[channel-drain] scheduler started (tick every ${channelDrainIntervalMs}ms)`
    : "[channel-drain] scheduler disabled");
});
// One scheduler for every node job in server/jobs.mjs. Growth watch and
// channel drain keep their previous intervals. Webhook retry, land-queue,
// claim polls, retention, and integrity run here too.
if (!paused && store) {
  try {
    nodeJobs = wireNodeJobs(store, {
      env: process.env,
      channelWebhooks: serverArgs.channelWebhooks,
      gmailAuth: serverArgs.gmailAuth
    });
    growthIntervalMs = nodeJobs.growthIntervalMs;
    channelDrainIntervalMs = nodeJobs.channelIntervalMs;
  } catch (error) {
    nodeJobs = null;
    console.warn(`[jobs] scheduler disabled: ${error?.message ?? error}`);
  }
}
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  if (!paused) {
    try { nodeJobs?.stop(); }
    catch (error) { console.warn(`[jobs] scheduler stop failed: ${error?.message ?? error}`); }
    try { saveToFile(growthSnapshotPath, growthCollector); }
    catch (error) { console.warn(`[growth] snapshot write failed: ${error?.message ?? error}`); }
  }
  server.closeStreams?.();
  server.close(() => { store?.close(); instanceLock?.release(); process.exit(0); });
  server.closeIdleConnections();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
