// Sequence-repro: does an oversize-413 followed by an empty-body POST
// deterministically cause the socket hang-up? (worker-41)
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const dbDir = mkdtempSync(join(process.env.WORKER41_TMP || tmpdir(), "worker41-seq-"));
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
      res.on("end", () => resolve({ name, status: res.statusCode, body: data.slice(0, 80) }));
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
const r1 = await one("oversize", { path: "/api/auth/recovery-codes/redeem", method: "POST", headers: { origin, "content-type": "application/json" } }, big);
console.log("oversize:", r1.status);
const r2 = await one("empty-after-oversize", { path: "/api/auth/recovery-codes/redeem", method: "POST", headers: { origin, "content-type": "application/json" } }, Buffer.from(""));
console.log("empty-after:", r2.status, r2.body);
// repeat twice more to check determinism
const r3 = await one("oversize2", { path: "/api/auth/recovery-codes/redeem", method: "POST", headers: { origin, "content-type": "application/json" } }, big);
const r4 = await one("empty-after2", { path: "/api/auth/recovery-codes/redeem", method: "POST", headers: { origin, "content-type": "application/json" } }, Buffer.from(""));
console.log("round2:", r3.status, r4.status, r4.body);
server.closeAllConnections(); server.close(() => process.exit(0));
store.close();
setTimeout(() => process.exit(0), 2000).unref();
