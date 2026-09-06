import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RoomStore } from "./server/store.mjs";
import { createRoomServer } from "./server/http.mjs";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
if (!["127.0.0.1", "::1", "localhost"].includes(host) || process.env.NODE_ENV === "production") throw new Error("This pilot binds only to loopback; production deployment requires a separate readiness review");
const filename = resolve(process.env.ROOM_DB || ".data/room.sqlite");
mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const store = new RoomStore(filename);
const origin = process.env.ROOM_ORIGIN || `http://${host === "::1" ? "[::1]" : host}:${port}`;
const server = createRoomServer({ store, origin });
server.listen(port, host, () => console.log(`Project Room pilot: ${origin}. Provision members before signing in; see docs/SERVICE.md.`));
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
