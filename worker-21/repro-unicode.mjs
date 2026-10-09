// Minimal repro: unicode token -> socket hang up on POST /api/referral-invites/preview
import http from "node:http";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { defaultServerArgs } from "../server/boot-options.mjs";

process.on("uncaughtException", e => { console.error("UNCAUGHT:", e); process.exit(9); });
process.on("unhandledRejection", e => { console.error("UNHANDLED:", e); process.exit(9); });

const PORT = 42141;
const store = new RoomStore("/home/hatch/workspace/pr-wave2000-guild-02/worker-21/.tmp/repro.sqlite");
const server = createRoomServer(defaultServerArgs({ store, origin: `http://127.0.0.1:${PORT}` }));
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
console.log("listening");

function post(token) {
  return new Promise(resolve => {
    const body = JSON.stringify({ token });
    const r = http.request({ method: "POST", hostname: "127.0.0.1", port: PORT, path: "/api/referral-invites/preview", headers: { "Content-Type": "application/json" }, timeout: 8000 }, res => {
      let n = 0; res.on("data", c => n += c.length);
      res.on("end", () => resolve(`status=${res.statusCode} bytes=${n}`));
    });
    r.on("timeout", () => { r.destroy(); resolve("TIMEOUT"); });
    r.on("error", e => resolve(`error=${e.message}`));
    r.write(body); r.end();
  });
}

for (const n of [1, 10, 100, 1000, 5000]) {
  const out = await post("💀".repeat(n));
  console.log(`emoji x${n}: ${out}`);
}
console.log("ascii sanity:", await post("bogus-token-123"));
server.close(); store.close(); process.exit(0);
