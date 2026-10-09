// Repro: GET /api/auth/magic/request transport failure (worker-12)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const directory = mkdtempSync(join(tmpdir(), "project-room-w12r-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom());
const server = createRoomServer({ store, streamInterval: 15 });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

process.on("uncaughtException", e => console.log("UNCAUGHT:", e.message, e.stack?.split("\n").slice(0,5).join(" | ")));
process.on("unhandledRejection", e => console.log("UNHANDLED:", e?.message ?? e));

for (const [label, method, headers] of [
  ["GET json-headers", "GET", { "Content-Type": "application/json", Origin: origin }],
  ["GET no-headers", "GET", {}],
  ["PUT json-headers", "PUT", { "Content-Type": "application/json", Origin: origin }],
  ["GET again", "GET", { "Content-Type": "application/json", Origin: origin }],
]) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(origin + "/api/auth/magic/request", { method, headers, signal: ctl.signal });
    console.log(label, "->", res.status, (await res.text()).slice(0, 80));
  } catch (e) {
    console.log(label, "-> FETCH-ERROR:", e.name, e.message, "| cause:", e.cause?.code ?? e.cause);
  } finally { clearTimeout(t); }
}
server.closeStreams(); server.closeAllConnections(); server.close(); store.close();
rmSync(directory, { recursive: true, force: true });
console.log("server survived:", true);
