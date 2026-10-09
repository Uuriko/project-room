// Server-side instrumentation: what happens to the empty-POST socket after a 413?
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const dbDir = mkdtempSync(join(process.env.WORKER41_TMP || tmpdir(), "worker41-inst-"));
const store = new RoomStore(join(dbDir, "room.db"));
const server = createRoomServer({ store });
let connN = 0;
server.on("connection", (s) => { const id = ++connN; console.log(`[srv] conn#${id} open from ${s.remotePort}`); s.on("close", () => console.log(`[srv] conn#${id} close`)); });
server.on("request", (req) => { console.log(`[srv] request ${req.method} ${req.url} clen=${req.headers["content-length"]}`); });
server.on("clientError", (e, s) => console.log("[srv] clientError:", e.message));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

function one(name, opts, bodyBuf) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, ...opts }, (res) => {
      console.log(`[cli] ${name} got status ${res.statusCode}`);
      res.resume();
      res.on("end", () => resolve({ name, status: res.statusCode }));
      res.on("error", (e) => resolve({ name, status: "RESP-ERR", body: e.message }));
    });
    req.setTimeout(6000);
    req.on("timeout", () => { req.destroy(new Error("client-timeout-6s")); });
    req.on("error", (e) => resolve({ name, status: "REQ-ERR", body: e.message }));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

const big = Buffer.from(JSON.stringify({ pad: "x".repeat(20000) }));
console.log(await one("oversize", { path: "/api/auth/recovery-codes/redeem", method: "POST", headers: { origin, "content-type": "application/json" } }, big));
await new Promise((r) => setTimeout(r, 300));
console.log(await one("empty-after", { path: "/api/auth/recovery-codes/redeem", method: "POST", headers: { origin, "content-type": "application/json" } }, Buffer.from("")));
await new Promise((r) => setTimeout(r, 1500));
server.closeAllConnections(); server.close(() => process.exit(0));
store.close();
setTimeout(() => process.exit(0), 2000).unref();
