import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { RoomStore } from "./server/store.mjs";
import { createRoomServer } from "./server/http.mjs";
import { deploymentConfig } from "./server/deployment.mjs";
import { createServer } from "node:http";
import { maintenanceEnabled, maintenanceReply } from "./server/maintenance.mjs";

const { host, port, origin, filename, production } = deploymentConfig();
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
}) : createRoomServer({ store, origin, trustedLocalProxy: production });
server.listen(port, host, () => console.log(`Project Room ${paused ? "paused" : production ? "invite-only pilot" : "local pilot"}: ${origin}`));
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.closeStreams?.();
  server.close(() => { store?.close(); process.exit(0); });
  server.closeIdleConnections();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
