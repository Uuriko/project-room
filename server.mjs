import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { RoomStore } from "./server/store.mjs";
import { stitchConfigFromEnv } from "./server/inbox-stitch.mjs";
import { createRoomServer } from "./server/http.mjs";
import { telegramConfig } from "./server/channel-adapters/telegram-config.mjs";
import { defaultServerArgs } from "./server/boot-options.mjs";
import { ChannelDrainer, createChannelDrainScheduler, channelDrainLimits } from "./server/channel-drain.mjs";
import { deploymentConfig } from "./server/deployment.mjs";
import { createServer } from "node:http";
import { maintenanceEnabled, maintenanceReply } from "./server/maintenance.mjs";
import { growthCollector } from "./src/growth-emit.js";
import { loadFromFile, saveToFile } from "./src/growth-persistence.js";
import { createWatcher } from "./src/growth-watch.js";
import { createScheduler, defaultGrowthRules, DEFAULT_INTERVAL_MS } from "./src/growth-scheduler.js";
import { createGrowthHttp } from "./src/growth-http.js";
import { acquireInstanceLock } from "./server/instance-lock.mjs";

const { host, port, origin, filename, production, streamInterval } = deploymentConfig();
const paused = maintenanceEnabled(process.env.ROOM_MAINTENANCE);
process.umask(0o077);
let havePilotDb = false;
try { havePilotDb = statSync(filename).isFile(); }
catch (error) { if (error?.code !== "ENOENT") throw error; }
if (!paused && production && !havePilotDb) throw new Error("Provision a persistent pilot database before startup");
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
// Track C C13/C14 — growth scheduler state. Declared before the server is
// created so the C14 read-only HTTP surface can close over live status via
// a getter evaluated per request (the scheduler itself starts after listen).
let growthScheduler = null;
let growthIntervalMs = 0;
// Task 9 — channel drain scheduler state. Declared before the server is
// created so the listen callback can report its status (same as growth).
let channelDrainScheduler = null;
let channelDrainIntervalMs = 0;
// Track C C14 — read-only growth HTTP surface (GET /growth/summary,
// /growth/digest, /growth/health). Pure reads over the collector and the
// scheduler-status getter: no emission, no mutation, no timers. Null in
// paused (maintenance) mode, where the minimal handler takes over.
const growthHttp = paused ? null : createGrowthHttp({
  collector: growthCollector,
  getSchedulerStatus: () => growthScheduler
    ? { running: growthScheduler.isRunning(), tickCount: growthScheduler.getTickCount(), intervalMs: growthIntervalMs }
    : { running: false, tickCount: 0, intervalMs: growthIntervalMs }
});
const serverArgs = paused ? null : defaultServerArgs({ store, origin, streamInterval, trustedLocalProxy: production, telegram: telegramConfig(process.env), growth: growthHttp });
const server = paused ? createServer((req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.origin !== origin || req.headers.host !== new URL(origin).host) {
      res.writeHead(403, { "Cache-Control": "no-store" }); res.end(); return;
    }
    const reply = maintenanceReply(url.pathname);
    res.writeHead(reply.status, reply.headers); res.end(req.method === "HEAD" ? undefined : reply.body);
  } catch { res.writeHead(400, { "Cache-Control": "no-store" }); res.end(); }
}) : createRoomServer(serverArgs);
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
  if (!paused) console.log(growthScheduler && growthScheduler.isRunning()
    ? `[growth] scheduler started (tick every ${growthIntervalMs}ms)`
    : "[growth] scheduler disabled");
  if (!paused) console.log(channelDrainScheduler && channelDrainScheduler.isRunning()
    ? `[channel-drain] scheduler started (tick every ${channelDrainIntervalMs}ms)`
    : "[channel-drain] scheduler disabled");
});
// Track C C13 — growth scheduler. Drives the C12 watcher on a fixed
// cadence and logs triggered alert hits (no delivery anywhere). Any
// failure here only costs alert logging, never boot or shutdown.
if (!paused) {
  try {
    const growthWatcher = createWatcher({ collector: growthCollector, rules: defaultGrowthRules() });
    const envInterval = process.env.GROWTH_WATCH_INTERVAL_MS;
    const intervalMs = envInterval === undefined || envInterval === "" ? DEFAULT_INTERVAL_MS : Number(envInterval);
    growthIntervalMs = intervalMs;
    growthScheduler = createScheduler({ watcher: growthWatcher, intervalMs });
    growthScheduler.start();
  } catch (error) {
    growthScheduler = null;
    console.warn(`[growth] scheduler disabled: ${error?.message ?? error}`);
  }
}
// Task 9 — scheduled auto-drain of pending_channel_updates. The drainer scans
// the journal on a fixed cadence and poison-screens pending slices (both are
// session-free); the inbox import itself stays owner-session bound until the
// B20 system import authority exists, so slices are honestly deferred, never
// imported. Any failure here only costs drain latency, never boot or shutdown.
if (!paused && serverArgs.channelWebhooks) {
  try {
    const drainer = new ChannelDrainer({ store, webhooks: serverArgs.channelWebhooks });
    const envInterval = process.env.CHANNEL_DRAIN_INTERVAL_MS;
    const intervalMs = envInterval === undefined || envInterval === "" ? channelDrainLimits.intervalMs : Number(envInterval);
    channelDrainIntervalMs = intervalMs;
    channelDrainScheduler = createChannelDrainScheduler({ drainer, intervalMs });
    channelDrainScheduler.start();
  } catch (error) {
    channelDrainScheduler = null;
    console.warn(`[channel-drain] scheduler disabled: ${error?.message ?? error}`);
  }
}
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  if (!paused) {
    try { growthScheduler?.stop(); }
    catch (error) { console.warn(`[growth] scheduler stop failed: ${error?.message ?? error}`); }
    try { channelDrainScheduler?.stop(); }
    catch (error) { console.warn(`[channel-drain] scheduler stop failed: ${error?.message ?? error}`); }
    try { saveToFile(growthSnapshotPath, growthCollector); }
    catch (error) { console.warn(`[growth] snapshot write failed: ${error?.message ?? error}`); }
  }
  server.closeStreams?.();
  server.close(() => { store?.close(); instanceLock?.release(); process.exit(0); });
  server.closeIdleConnections();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
