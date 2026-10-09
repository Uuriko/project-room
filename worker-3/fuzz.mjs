#!/usr/bin/env node
// Worker-3 fuzz harness: malformed / oversized / adversarial requests against
// local server only (127.0.0.1:4773). Never production.
import http from "node:http";
import net from "node:net";

const HOST = "127.0.0.1", PORT = 4773, TIMEOUT = 8000;
const results = [];

function req(method, path, { headers = {}, body = null, rawPath = false } = {}) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ error: "TIMEOUT", method, path }), TIMEOUT);
    const r = http.request({ host: HOST, port: PORT, method, path, headers }, (res) => {
      let n = 0; res.on("data", (c) => { n += c.length; });
      res.on("end", () => { clearTimeout(t); resolve({ status: res.statusCode, bytes: n, method, path }); });
    });
    r.on("error", (e) => { clearTimeout(t); resolve({ error: e.code || e.message, method, path }); });
    if (body) r.write(body);
    r.end();
  });
}

// Raw socket for request-line / header smuggling shapes
function raw(data, label) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, HOST, () => s.write(data));
    const t = setTimeout(() => { s.destroy(); resolve({ label, error: "TIMEOUT" }); }, TIMEOUT);
    let buf = "";
    s.on("data", (c) => { buf += c.toString("latin1"); });
    s.on("end", () => { clearTimeout(t); resolve({ label, first: buf.slice(0, 60).replace(/\r/g, "\\r").replace(/\n/g, "\\n") }); });
    s.on("error", (e) => { clearTimeout(t); resolve({ label, error: e.code || e.message }); });
  });
}

function log(r) { results.push(r); const s = r.status ?? r.error ?? r.first; console.log(`${r.method ?? ""} ${r.path ?? r.label} => ${s}`); }

const T = async () => {
  // ---- /api/health path shapes (GET) ----
  const healthPaths = [
    "/api/health", "/api/health/", "/API/HEALTH", "/Api/Health",
    "//api/health", "/api//health", "/api/./health", "/api/../api/health",
    "/%61pi/health", "/api/health%2f", "/api/health%00", "/api/health%zz",
    "/api/health?", "/api/health?x=" + "y".repeat(10), "/api/health?" + "x".repeat(40000),
    "/api/health" + "x".repeat(4000), "/api/healthz", "/healthz", "/room/health",
    "/room/health/", "/room/api/health/", "/api/healthz/", "/room/healthz",
    "/api/health/.", "/api/health..", "/api/HEALTHZ", "/api/health%252f",
    "/api/health%20", "/api/health%2e", "/%2fapi%2fhealth",
  ];
  for (const p of healthPaths) log(await req("GET", p));
  // ---- /api/health methods ----
  for (const m of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT", "FOOBAR"]) {
    log(await req(m, "/api/health"));
  }
  for (const m of ["POST", "DELETE", "HEAD"]) {
    log(await req(m, "/api/healthz"));
    log(await req(m, "/room/health"));
  }
  // ---- /api/account/profile ----
  for (const m of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "FOOBAR"]) log(await req(m, "/api/account/profile"));
  log(await req("POST", "/api/account/profile"));                                   // no auth/origin
  log(await req("POST", "/api/account/profile", { headers: { origin: "http://evil.example" }, body: "{}" }));
  log(await req("POST", "/api/account/profile", { headers: { "content-type": "application/json" }, body: "not json{{" }));
  log(await req("POST", "/api/account/profile", { headers: { "content-type": "application/json" }, body: "" }));
  log(await req("POST", "/api/account/profile", { headers: { "content-type": "application/json" }, body: "[]" }));
  log(await req("POST", "/api/account/profile", { headers: { "content-type": "application/json" }, body: '"str"' }));
  log(await req("POST", "/api/account/profile", { headers: { "content-type": "application/json" }, body: "null" }));
  log(await req("POST", "/api/account/profile", { headers: { "content-type": "application/json", "content-length": "100000" }, body: '{"a":1}' }));
  log(await req("POST", "/api/account/profile", { headers: { "content-type": "application/json" }, body: "x".repeat(100000) }));
  log(await req("POST", "/api/account/profile", { headers: { "content-type": "application/json" }, body: "[".repeat(10000) }));
  log(await req("GET", "/api/account/profile", { headers: { cookie: "x".repeat(20000) } }));
  // (CRLF-in-cookie case moved to raw socket below)
  // ---- /api/updates ----
  for (const m of ["POST", "PUT", "DELETE", "OPTIONS", "FOOBAR"]) log(await req(m, "/api/updates"));
  log(await req("GET", "/api/updates"));                                            // no auth
  log(await req("GET", "/api/updates", { headers: { authorization: "Bearer garbage" } }));
  log(await req("GET", "/api/updates", { headers: { authorization: "Bearer" } }));
  log(await req("GET", "/api/updates", { headers: { authorization: "bearer x" } }));
  log(await req("HEAD", "/api/updates"));
  const q = [
    "?limit=abc", "?limit=-1", "?limit=0", "?limit=99999999999999", "?limit=1e3",
    "?limit=0x10", "?limit=+5", "?limit=1&limit=2", "?limit=", "?limit=NaN",
    "?cursor=" + "c".repeat(100000), "?state=a&state=b", "?kinds=x&kinds=y&kinds=z",
    "?unknownParam=1", "?" + "p".repeat(30000), "?limit=%zz", "?limit=%2e",
    "?limit=99999999999999999999999999", "?kinds=" + "k".repeat(20000),
  ];
  for (const qs of q) log(await req("GET", "/api/updates" + qs));
  // ---- raw socket shapes ----
  const raws = [
    ["GARBAGE / HTTP/1.1\r\nHost: x\r\n\r\n", "garbage-verb"],
    ["GET /api/health HTTP/1.0\r\n\r\n", "http10-no-host"],
    ["GET /api/health\r\n\r\n", "no-version"],
    ["\r\n\r\n", "blank-line"],
    ["GET " + "/api/health".padEnd(9000, "x") + " HTTP/1.1\r\nHost: x\r\n\r\n", "huge-target"],
    ["GET /api/health HTTP/1.1\r\nHost: x\r\nX-Big: " + "y".repeat(20000) + "\r\n\r\n", "huge-header"],
    ["GET /api/health HTTP/1.1\r\nHost: x\r\nHost: y\r\n\r\n", "dup-host"],
    ["GET /api/health HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\n", "dup-cl"],
    ["GET /api/health HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", "chunked-get"],
    ["\x00GET /api/health HTTP/1.1\r\nHost: x\r\n\r\n", "null-prefix"],
    ["GET /\x00api/health HTTP/1.1\r\nHost: x\r\n\r\n", "null-in-target"],
    ["SMUGGLE /api/health HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n", "smuggle-verb"],
    ["GET /api/account/profile HTTP/1.1\r\nHost: x\r\nCookie: a=%zz\r\n\r\n", "pct-cookie"],
    ["GET /api/account/profile HTTP/1.1\r\nHost: x\r\nCookie: " + "q".repeat(30000) + "\r\n\r\n", "huge-cookie"],
  ];
  for (const [d, l] of raws) log(await raw(d, l));
  console.log(`\nTOTAL: ${results.length}`);
  const crashes = results.filter((r) => r.error && r.error !== "TIMEOUT" && !["ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(r.error));
  const timeouts = results.filter((r) => r.error === "TIMEOUT");
  console.log("non-timeout transport errors:", JSON.stringify(crashes));
  console.log("timeouts:", timeouts.length, JSON.stringify(timeouts.map((t) => t.path ?? t.label)));
};

await T();
