// Is the GET failure a keep-alive artifact of the early-413 drain? (worker-12)
// Uses node:http directly for precise socket-reuse control.
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const directory = mkdtempSync(join(tmpdir(), "project-room-w12k-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom());
const server = createRoomServer({ store, streamInterval: 15 });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function rawRequest(agent, { method, path, headers = {}, body = null }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port, path, method, agent, headers, timeout: 8000 }, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data.slice(0, 60), ms: Date.now() - t0 }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: "TIMEOUT", ms: Date.now() - t0 }); });
    req.on("error", e => resolve({ status: "SOCKET-ERROR", body: e.code ?? e.message, ms: Date.now() - t0 }));
    if (body) req.write(body);
    req.end();
  });
}

const big = JSON.stringify({ email: "a@b.co", pad: "x".repeat(12 * 1024 * 1024) });
const MAGIC = "/api/auth/magic/request";

for (const [label, keepAlive] of [["keep-alive-agent", true], ["close-per-request", false]]) {
  const agent = new http.Agent({ keepAlive });
  const slot = store.createAccountSessionSlot();
  const slotBack = store.accountSessionSlot(slot.token);
  const authH = { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`,
    Cookie: `account_session=${slot.token}`, "x-csrf-token": slotBack.csrf };
  const r1 = await rawRequest(agent, { method: "POST", path: MAGIC,
    headers: { ...authH, "Content-Length": Buffer.byteLength(big) }, body: big });
  const r2 = await rawRequest(agent, { method: "GET", path: MAGIC, headers: { Origin: `http://127.0.0.1:${port}` } });
  const r3 = await rawRequest(agent, { method: "GET", path: MAGIC, headers: { Origin: `http://127.0.0.1:${port}` } });
  console.log(label, "| POST12MB ->", r1.status, r1.ms + "ms", "| GET#1 ->", r2.status, JSON.stringify(r2.body), "| GET#2 ->", r3.status);
  agent.destroy();
}
server.closeStreams(); server.closeAllConnections(); server.close(); store.close();
rmSync(directory, { recursive: true, force: true });
console.log("done; server alive throughout");
