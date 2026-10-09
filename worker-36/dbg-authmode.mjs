import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const directory = mkdtempSync(join(tmpdir(), "w36-dbg-"));
const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
store.initialize(initialRoom());
const server = createRoomServer({ store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function probe(label, method, path, opts = {}) {
  const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, "Content-Type": "application/json", ...opts.headers }, body: opts.body, signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  console.log(label, "->", res.status, text.slice(0, 300));
}
const payload = JSON.stringify({ messageId: "m2", reason: "x" });
await probe("GET  no-cred ?auth=banana", "GET", "/api/rooms/commons/reminders?auth=banana");
await probe("POST no-cred ?auth=banana", "POST", "/api/rooms/commons/reports?auth=banana", { body: payload });
await probe("POST no-cred no-param   ", "POST", "/api/rooms/commons/reports", { body: payload });
await probe("GET  no-cred no-param   ", "GET", "/api/rooms/commons/reminders");

server.closeStreams(); server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
store.close(); rmSync(directory, { recursive: true, force: true });
