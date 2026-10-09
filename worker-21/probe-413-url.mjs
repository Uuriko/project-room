// Follow-up probes: (a) is the post-413 hang-up just a keep-alive race vs the
// intentional drain-then-half-close? (b) URL-length sweep on the GET preview route.
import http from "node:http";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { defaultServerArgs } from "../server/boot-options.mjs";

const PORT = 42151;
const store = new RoomStore("/home/hatch/workspace/pr-wave2000-guild-02/worker-21/.tmp/probe.sqlite");
const server = createRoomServer(defaultServerArgs({ store, origin: `http://127.0.0.1:${PORT}` }));
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

function one(path, { method = "GET", body = undefined, agent = undefined, headers = {} } = {}) {
  return new Promise(resolve => {
    const r = http.request({ method, hostname: "127.0.0.1", port: PORT, path, headers: { "Content-Type": "application/json", ...headers }, agent, timeout: 8000 }, res => {
      let n = 0; res.on("data", c => n += c.length);
      res.on("end", () => resolve(`status=${res.statusCode}`));
    });
    r.on("timeout", () => { r.destroy(); resolve("TIMEOUT"); });
    r.on("error", e => resolve(`error=${e.code || e.message}`));
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const J = o => JSON.stringify(o);

console.log("--- (a) 413 then next request on FRESH connection ---");
const big = J({ token: "x".repeat(200000) });
console.log("oversize POST:", await one("/api/referral-invites/preview", { method: "POST", body: big, agent: false }));
console.log("next req fresh conn:", await one("/api/referral-invites/preview", { method: "POST", body: J({ token: "bogus" }), agent: false }));
console.log("health fresh conn:", await one("/api/health", { agent: false }));

console.log("--- (b) URL-length sweep on GET /api/agent-invites/preview ---");
for (const n of [1000, 4000, 8000, 12000, 16000, 200000]) {
  const out = await one(`/api/agent-invites/preview?code=${"x".repeat(n)}`, { agent: false });
  console.log(`code len ${n}: ${out}`);
}
console.log("health after sweep:", await one("/api/health", { agent: false }));

server.close(); store.close(); process.exit(0);
