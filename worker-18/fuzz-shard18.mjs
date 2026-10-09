// WORKER-18 fuzz harness — shard: server/http.mjs legacy-chain handlers
//   1. GET/HEAD /api/ready  (http.mjs:1631)
//   2. POST /api/share-links/preview (http.mjs:2529)
// Local server: http://127.0.0.1:41871 (fresh scratch DB, no rooms seeded)
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:41871";
const ORIGIN = BASE;

const results = [];
let pass = 0, fail = 0;

async function probe(name, opts, expect) {
  const { method = "GET", path, headers = {}, body = undefined, rawBody = undefined } = opts;
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (rawBody !== undefined) init.body = rawBody;
  else if (body !== undefined) init.body = body;
  const t0 = Date.now();
  let res, text = "", err = null;
  try {
    res = await fetch(BASE + path, init);
    text = await res.text();
  } catch (e) { err = e; }
  const ms = Date.now() - t0;
  const got = err ? `ERROR:${err.cause?.code || err.message}` : `${res.status}`;
  const ok = expect ? expect({ status: res?.status, text, err }) : true;
  if (ok) pass++; else fail++;
  results.push({ name, method, path, got, ms, ok, body: text.slice(0, 160) });
  return { res, text, err };
}

const jsonHeaders = (extra = {}) => ({ Origin: ORIGIN, "Content-Type": "application/json", ...extra });

console.log("=== /api/ready (empty DB: expect 503 unavailable) ===");
await probe("ready GET", { path: "/api/ready" }, ({ status, text }) => status === 503 && text.includes('"unavailable"'));
await probe("ready HEAD", { method: "HEAD", path: "/api/ready" }, ({ status, text }) => status === 503 && text === "");
await probe("ready POST falls through", { method: "POST", path: "/api/ready" }, ({ status }) => status === 404);
await probe("ready PUT falls through", { method: "PUT", path: "/api/ready" }, ({ status }) => status === 404);
await probe("ready trailing slash", { path: "/api/ready/" }, ({ status }) => status === 404);
await probe("ready with query", { path: "/api/ready?x=1&y=2" }, ({ status }) => status === 503);
await probe("ready long query", { path: "/api/ready?" + "a".repeat(8000) }, ({ status }) => status === 503);
await probe("ready weird method", { method: "OPTIONS", path: "/api/ready" }, ({ status }) => status === 404 || status === 405);
await probe("ready case path", { path: "/API/READY" }, ({ status }) => status === 404);

console.log("=== /api/share-links/preview origin gate ===");
await probe("preview no origin", { method: "POST", path: "/api/share-links/preview", headers: { "Content-Type": "application/json" }, body: "{}" }, ({ status }) => status === 403);
await probe("preview wrong origin", { method: "POST", path: "/api/share-links/preview", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" }, ({ status }) => status === 403);
await probe("preview edge-door origin allowed (no link)", { method: "POST", path: "/api/share-links/preview", headers: { Origin: "https://getdasha.com", "Content-Type": "application/json" }, body: "{}" }, ({ status }) => status === 422 || status === 403);

console.log("=== /api/share-links/preview body shapes ===");
const J = jsonHeaders();
await probe("preview no content-type", { method: "POST", path: "/api/share-links/preview", headers: { Origin: ORIGIN }, body: "{}" }, ({ status }) => status === 415);
await probe("preview text/plain", { method: "POST", path: "/api/share-links/preview", headers: { Origin: ORIGIN, "Content-Type": "text/plain" }, body: "{}" }, ({ status }) => status === 415);
await probe("preview invalid json", { method: "POST", path: "/api/share-links/preview", headers: J, rawBody: "not json{{{" }, ({ status, text }) => status === 400 && text.includes("invalid_json") );
await probe("preview json array", { method: "POST", path: "/api/share-links/preview", headers: J, body: "[1,2]" }, ({ status }) => status === 400);
await probe("preview json null", { method: "POST", path: "/api/share-links/preview", headers: J, body: "null" }, ({ status }) => status === 400);
await probe("preview json string", { method: "POST", path: "/api/share-links/preview", headers: J, body: '"str"' }, ({ status }) => status === 400);
await probe("preview empty object", { method: "POST", path: "/api/share-links/preview", headers: J, body: "{}" }, ({ status, text }) => status === 422 && text.includes("invalid_link") );
await probe("preview extra key", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":"x","extra":1}' }, ({ status }) => status === 422);
await probe("preview missing key + other", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"foo":1}' }, ({ status }) => status === 422);
await probe("preview token number", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":123}' }, ({ status }) => status === 410);
await probe("preview token null", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":null}' }, ({ status }) => status === 410);
await probe("preview token bool", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":true}' }, ({ status }) => status === 410);
await probe("preview token object", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":{"a":1}}' }, ({ status }) => status === 410);
await probe("preview token short string", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":"abc"}' }, ({ status }) => status === 410);
await probe("preview token 43char unknown", { method: "POST", path: "/api/share-links/preview", headers: J, body: `{"linkToken":"${"A".repeat(43)}"}` }, ({ status }) => status === 410);
await probe("preview guest-agent kind", { method: "POST", path: "/api/share-links/preview", headers: J, body: `{"linkToken":"ga1.${"B".repeat(43)}"}` }, ({ status, text }) => status === 422 && text.includes("wrong_link_kind") );
await probe("preview share code unknown", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":"#code/AAAAAAAAA"}' }, ({ status }) => status === 410);
await probe("preview token huge string", { method: "POST", path: "/api/share-links/preview", headers: J, body: `{"linkToken":"${"C".repeat(15000)}"}` }, ({ status }) => status === 410);
await probe("preview empty string token", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":""}' }, ({ status }) => status === 410);
await probe("preview GET falls through", { method: "GET", path: "/api/share-links/preview", headers: { Origin: ORIGIN } }, ({ status }) => status === 404);
await probe("preview no origin + Bearer <redacted>", { method: "POST", path: "/api/share-links/preview", headers: { Authorization: "Bearer <redacted>", "Content-Type": "application/json" }, body: "{}" }, ({ status }) => status === 422);

console.log("=== oversize body ===");
await probe("preview 20KB body -> 413", { method: "POST", path: "/api/share-links/preview", headers: J, body: `{"linkToken":"${"D".repeat(20000)}"}` }, ({ status, text }) => status === 413 && text.includes("too_large") );

console.log("\n=== SUMMARY ===");
console.log(`pass=${pass} fail=${fail}`);
for (const r of results.filter(r => !r.ok)) console.log("FAIL:", r.name, r.method, r.path, "got", r.got, r.ms + "ms", r.body);
for (const r of results) {
  // hang detection: any single request > 10s
  if (r.ms > 10000) console.log("SLOW/HANG:", r.name, r.ms + "ms");
}
