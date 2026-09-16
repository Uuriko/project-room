import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { RoomStore } from "./server/store.mjs";
import { createRoomServer } from "./server/http.mjs";
import { telegramConfig } from "./server/channel-adapters/telegram-config.mjs";
import { deploymentConfig } from "./server/deployment.mjs";
import { createServer } from "node:http";
import { maintenanceEnabled, maintenanceReply } from "./server/maintenance.mjs";
import { growthCollector } from "./src/growth-emit.js";
import { loadFromFile, saveToFile } from "./src/growth-persistence.js";
import { createWatcher } from "./src/growth-watch.js";
import { createScheduler, defaultGrowthRules, DEFAULT_INTERVAL_MS } from "./src/growth-scheduler.js";

const { host, port, origin, filename, production, streamInterval } = deploymentConfig();
const paused = maintenanceEnabled(process.env.ROOM_MAINTENANCE);
process.umask(0o077);
let havePilotDb = false;
try { havePilotDb = statSync(filename).isFile(); }
catch (error) { if (error?.code !== "ENOENT") throw error; }
if (!paused && production && !havePilotDb) throw new Error("Provision a persistent pilot database before startup");
if (!paused) mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const store = paused ? null : new RoomStore(filename);
if (store && production && !store.db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) { store.close(); throw new Error("Provision a room before deployment"); }
const server = paused ? createServer((req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.origin !== origin || req.headers.host !== new URL(origin).host) {
      res.writeHead(403, { "Cache-Control": "no-store" }); res.end(); return;
    }
    const reply = maintenanceReply(url.pathname);
    res.writeHead(reply.status, reply.headers); res.end(req.method === "HEAD" ? undefined : reply.body);
  } catch { res.writeHead(400, { "Cache-Control": "no-store" }); res.end(); }
}) : createRoomServer({ store, origin, streamInterval, trustedLocalProxy: production, telegram: telegramConfig(process.env) });
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
server.listen(port, host, () => console.log(`Project Room ${paused ? "paused" : production ? "invite-only pilot" : "local pilot"}: ${origin}`));
// Track C C13 — growth scheduler. Drives the C12 watcher on a fixed
// cadence and logs triggered alert hits (no delivery anywhere). Any
// failure here only costs alert logging, never boot or shutdown.
let growthScheduler = null;
if (!paused) {
  try {
    const growthWatcher = createWatcher({ collector: growthCollector, rules: defaultGrowthRules() });
    const envInterval = process.env.GROWTH_WATCH_INTERVAL_MS;
    const intervalMs = envInterval === undefined || envInterval === "" ? DEFAULT_INTERVAL_MS : Number(envInterval);
    growthScheduler = createScheduler({ watcher: growthWatcher, intervalMs });
    growthScheduler.start();
    console.log(growthScheduler.isRunning()
      ? `[growth] scheduler started (tick every ${intervalMs}ms)`
      : "[growth] scheduler disabled (interval <= 0)");
  } catch (error) {
    growthScheduler = null;
    console.warn(`[growth] scheduler disabled: ${error?.message ?? error}`);
  }
}
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  if (!paused) {
    try { growthScheduler?.stop(); }
    catch (error) { console.warn(`[growth] scheduler stop failed: ${error?.message ?? error}`); }
    try { saveToFile(growthSnapshotPath, growthCollector); }
    catch (error) { console.warn(`[growth] snapshot write failed: ${error?.message ?? error}`); }
  }
  server.closeStreams?.();
  server.close(() => { store?.close(); process.exit(0); });
  server.closeIdleConnections();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
