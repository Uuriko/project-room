// Minimal repro for worker-41 anomalies: B9 (empty POST body -> socket hang up)
// and D11 (X-Forwarded-For -> socket hang up).
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const dbDir = mkdtempSync(join(process.env.WORKER41_TMP || tmpdir(), "worker41-repro-"));
const store = new RoomStore(join(dbDir, "room.db"));
const server = createRoomServer({ store });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

function one(name, opts, bodyBuf) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, ...opts }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ name, status: res.statusCode, body: data.slice(0, 300) }));
      res.on("error", (e) => resolve({ name, status: "RESP-ERR", body: e.message }));
    });
    req.setTimeout(6000);
    req.on("timeout", () => { req.destroy(new Error("client-timeout-6s")); });
    req.on("error", (e) => resolve({ name, status: "REQ-ERR", body: e.message }));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

const r1 = await one("B9-empty-body-redeem",
  { path: "/api/auth/recovery-codes/redeem", method: "POST", headers: { origin, "content-type": "application/json" } });
console.log("B9:", JSON.stringify(r1));

const r2 = await one("D11-xff-spoof",
  { path: "/api/access-requests", method: "GET", headers: { "x-forwarded-for": "203.0.113.9" } });
console.log("D11:", JSON.stringify(r2));

// sanity: same requests that worked before
const r3 = await one("B9-control-nonempty",
  { path: "/api/auth/recovery-codes/redeem", method: "POST", headers: { origin, "content-type": "application/json" } },
  Buffer.from('{"email":"a@b.co","code":"x","sessionRevision":1,"sessionToken":"t"}'));
console.log("control:", JSON.stringify(r3));

const r4 = await one("D11-control-no-xff",
  { path: "/api/access-requests", method: "GET" });
console.log("control2:", JSON.stringify(r4));

server.closeAllConnections(); server.close(() => process.exit(0));
store.close();
setTimeout(() => process.exit(0), 2000).unref();
