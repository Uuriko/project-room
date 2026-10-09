// WAVE-2000 guild-02 worker-11: unauthenticated fuzz of shard routes.
// Run: node worker-11/fuzz-unauth.mjs   (server expected at http://127.0.0.1:18011)
const ORIGIN = process.env.FUZZ_ORIGIN || "http://127.0.0.1:18011";

const results = [];
async function probe(name, method, path, { body = undefined, headers = {} } = {}) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 8000);
  const t0 = Date.now();
  let status = null, note = "", bodyText = "";
  try {
    const res = await fetch(`${ORIGIN}${path}`, { method, headers, body, signal: ctl.signal });
    status = res.status;
    bodyText = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
    note = `allow=${res.headers.get("allow") || "-"} ct=${res.headers.get("content-type") || "-"}`;
  } catch (e) {
    status = e.name === "AbortError" ? "HANG/TIMEOUT" : `FETCH-ERR:${e.message.slice(0, 60)}`;
  } finally {
    clearTimeout(to);
  }
  const ms = Date.now() - t0;
  results.push({ name, method, path: path.slice(0, 80), status, ms, note, bodyText });
  console.log(`${String(status).padEnd(12)} ${ms.toString().padStart(5)}ms  ${method.padEnd(6)} ${path.slice(0, 70)}  ${bodyText.slice(0, 80)}`);
}

// R10 (index 10, L1367): GET /.well-known/oauth-authorization-server
await probe("R10 base", "GET", "/.well-known/oauth-authorization-server");
await probe("R10 HEAD", "HEAD", "/.well-known/oauth-authorization-server");
await probe("R10 POST", "POST", "/.well-known/oauth-authorization-server", { body: "{}" });
await probe("R10 query", "GET", "/.well-known/oauth-authorization-server?x=1&evil=<script>");
await probe("R10 trailing-slash", "GET", "/.well-known/oauth-authorization-server/");
await probe("R10 longquery", "GET", "/.well-known/oauth-authorization-server?" + "a=".repeat(4000));
await probe("R10 DELETE", "DELETE", "/.well-known/oauth-authorization-server");

// R60 (index 60, L2286): /api/auth/methods/remove
await probe("R60 GET", "GET", "/api/auth/methods/remove");
await probe("R60 POST empty", "POST", "/api/auth/methods/remove", { headers: { "content-type": "application/json" }, body: "{}" });
await probe("R60 POST nonjson", "POST", "/api/auth/methods/remove", { headers: { "content-type": "application/json" }, body: "not-json{{{" });
await probe("R60 POST bogus-bearer", "POST", "/api/auth/methods/remove", { headers: { "content-type": "application/json", authorization: "Bearer bogus" }, body: '{"id":"x"}' });
await probe("R60 OPTIONS", "OPTIONS", "/api/auth/methods/remove");

// R110 (index 110, L3105): !=POST /api/access-requests -> 405
for (const m of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"])
  await probe(`R110 ${m}`, m, "/api/access-requests");

// R160 (index 160, L3417): /api/rooms/{id}/mentions/{eid}/ack
await probe("R160 GET noauth", "GET", "/api/rooms/commons/mentions/evt123/ack");
await probe("R160 POST noauth", "POST", "/api/rooms/commons/mentions/evt123/ack", { headers: { "content-type": "application/json" }, body: "{}" });
await probe("R160 POST badbearer", "POST", "/api/rooms/commons/mentions/evt123/ack", { headers: { "content-type": "application/json", authorization: "Bearer bogus" }, body: "{}" });
await probe("R160 POST badroom", "POST", "/api/rooms/!bad!/mentions/evt123/ack", { headers: { "content-type": "application/json", authorization: "Bearer bogus" }, body: "{}" });
await probe("R160 POST longroom", "POST", "/api/rooms/" + "r".repeat(385) + "/mentions/evt123/ack", { headers: { authorization: "Bearer bogus" } });
await probe("R160 POST encoded", "POST", "/api/rooms/%2e%2e/mentions/%2f/ack", { headers: { authorization: "Bearer bogus" } });

// R210 (index 210, L3513): /api/rooms/{id}/bounties
await probe("R210 GET noauth", "GET", "/api/rooms/commons/bounties");
await probe("R210 POST noauth-garbage", "POST", "/api/rooms/commons/bounties", { headers: { "content-type": "application/json" }, body: "{bad" });
await probe("R210 PUT noauth", "PUT", "/api/rooms/commons/bounties", { headers: { "content-type": "application/json" }, body: "{}" });
await probe("R210 GET weirdqs", "GET", "/api/rooms/commons/bounties?limit=abc&group=<b>");
await probe("R210 GET badroom", "GET", "/api/rooms/..%2f..%2f/bounties");

import { writeFileSync } from "node:fs";
writeFileSync("worker-11/fuzz-unauth-results.json", JSON.stringify(results, null, 1));
console.log("\n-- anomalies (5xx / HANG / unexpected) --");
for (const r of results) {
  if (r.status === "HANG/TIMEOUT" || (typeof r.status === "number" && r.status >= 500))
    console.log("ANOMALY:", JSON.stringify(r));
}
