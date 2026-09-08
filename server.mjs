import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { RoomStore } from "./server/store.mjs";
import { createRoomServer } from "./server/http.mjs";
import { deploymentConfig } from "./server/deployment.mjs";

const { host, port, origin, filename, production } = deploymentConfig();
process.umask(0o077);
if (production && !statSync(filename).isFile()) throw new Error("Provision a persistent pilot database before startup");
mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const store = new RoomStore(filename);
if (production && !store.db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) { store.close(); throw new Error("Provision a room before deployment"); }
const server = createRoomServer({ store, origin, trustedLocalProxy: production });
server.listen(port, host, () => console.log(`Project Room ${production ? "invite-only pilot" : "local pilot"}: ${origin}`));
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.closeStreams();
  server.close(() => { store.close(); process.exit(0); });
  server.closeIdleConnections();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
