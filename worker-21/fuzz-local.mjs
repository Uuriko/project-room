// WAVE-2000 G02 worker-21: in-process API fuzz harness.
// Boots the REAL createRoomServer (same as server.mjs) on a scratch DB inside this
// process, fuzzes the shard endpoints, then shuts down. No external server lifetime.
import http from "node:http";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { defaultServerArgs } from "../server/boot-options.mjs";

const PORT = 42131;
const DB = "/home/hatch/workspace/pr-wave2000-guild-02/worker-21/.tmp/fuzz-inproc.sqlite";

const store = new RoomStore(DB);
const server = createRoomServer(defaultServerArgs({ store, origin: `http://127.0.0.1:${PORT}` }));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});
console.log(`in-process server listening on ${PORT}`);

const BASE = `http://127.0.0.1:${PORT}`;

function req({ method = "GET", path = "/", body = undefined, headers = {}, timeoutMs = 8000 }) {
  return new Promise(resolve => {
    const u = new URL(path, BASE);
    const opts = { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers };
    const r = http.request(opts, res => {
      let chunks = 0;
      res.on("data", c => { chunks += c.length; if (chunks > 1e6) r.destroy(); });
      res.on("end", () => resolve({ status: res.statusCode, bytes: chunks }));
      res.on("error", e => resolve({ error: `resp:${e.message}` }));
    });
    const t = setTimeout(() => { r.destroy(new Error("timeout")); }, timeoutMs);
    r.on("error", e => { clearTimeout(t); resolve(e.message.includes("timeout") ? { error: "TIMEOUT/HANG" } : { error: `conn:${e.message}` }); });
    r.on("close", () => clearTimeout(t));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const J = o => JSON.stringify(o);
const results = [];
async function case_(name, opts, expectNote = "") {
  const r = await req(opts);
  results.push({ name, ...r, note: expectNote });
  console.log(`${r.status ?? r.error}  ${name}${expectNote ? "   [" + expectNote + "]" : ""}`);
  return r;
}

const big = "x".repeat(200000);
const uni = "💀".repeat(5000);

console.log("--- POST /api/referral-invites/preview (http.mjs:3026) ---");
const H = { "Content-Type": "application/json" };
await case_("no body", { method: "POST", path: "/api/referral-invites/preview", headers: H });
await case_("empty object", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J({}) }, "expect 422");
await case_("token bogus", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J({ token: "bogus-token-123" }) }, "expect 200/404/422");
await case_("token number", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J({ token: 42 }) }, "expect 422");
await case_("token null", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J({ token: null }) }, "expect 422");
await case_("token object", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J({ token: { a: 1 } }) }, "expect 422");
await case_("token array", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J({ token: [] }) }, "expect 422");
await case_("extra keys", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J({ token: "x", admin: true }) }, "expect 422 (exact)");
await case_("body is array", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J([1, 2]) }, "expect 400");
await case_("body is string", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J("hi") }, "expect 400");
await case_("body is number", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: "42" }, "expect 400");
await case_("malformed json", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: "{not json" }, "expect 400");
await case_("wrong content-type", { method: "POST", path: "/api/referral-invites/preview", headers: { "Content-Type": "text/plain" }, body: J({ token: "x" }) }, "expect 415");
await case_("no content-type", { method: "POST", path: "/api/referral-invites/preview", body: J({ token: "x" }) }, "expect 415");
await case_("huge token", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J({ token: big }) }, "expect 200/404/422");
await case_("unicode token", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: J({ token: uni }) }, "expect 200/404/422");
await case_("proto pollution key", { method: "POST", path: "/api/referral-invites/preview", headers: H, body: '{"token":"x","__proto__":{"a":1}}' }, "expect 422");
await case_("GET instead of POST", { method: "GET", path: "/api/referral-invites/preview" }, "expect 405");
await case_("PUT instead of POST", { method: "PUT", path: "/api/referral-invites/preview", headers: H, body: J({ token: "x" }) }, "expect 405");

console.log("--- GET /api/agent-invites/preview (http.mjs:3038) ---");
await case_("no code", { method: "GET", path: "/api/agent-invites/preview" }, "expect 422");
await case_("empty code", { method: "GET", path: "/api/agent-invites/preview?code=" }, "expect 422");
await case_("bogus code", { method: "GET", path: "/api/agent-invites/preview?code=bogus-abc-123" }, "expect 200/404");
await case_("huge code", { method: "GET", path: `/api/agent-invites/preview?code=${big}` }, "expect 200/404");
await case_("unicode code", { method: "GET", path: `/api/agent-invites/preview?code=${encodeURIComponent(uni)}` }, "expect 200/404");
await case_("sql-ish code", { method: "GET", path: `/api/agent-invites/preview?code=${encodeURIComponent("' OR '1'='1")}` }, "expect 200/404");
await case_("duplicate code param", { method: "GET", path: "/api/agent-invites/preview?code=a&code=b" }, "expect ?");
await case_("POST instead of GET", { method: "POST", path: "/api/agent-invites/preview?code=x", headers: H, body: J({}) }, "expect 404/405");

console.log("--- sanity ---");
await case_("health after fuzz", { method: "GET", path: "/api/health" }, "expect 200");

const bad = results.filter(r => r.error || r.status >= 500);
console.log(`\nTOTAL ${results.length}, BAD(5xx|error|hang): ${bad.length}`);
for (const b of bad) console.log("BAD:", JSON.stringify(b));

server.close();
store.close();
process.exit(bad.length ? 2 : 0);
