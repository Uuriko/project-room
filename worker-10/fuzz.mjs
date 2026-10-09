#!/usr/bin/env node
// WAVE-2000 guild-02 worker-10 fuzz harness — shard idx 9, 59.
// Boots a local server (createRoomServer) with a throwaway sqlite store and
// fuzzes:
//   A. GET /api/auth/github/start      (http.mjs:1260) — OAuth unconfigured → 503
//   B. GET/HEAD /api/guest-agent-links (http.mjs:2416) — 200 JSON contract
// Never touches production. Every request has an 8s timeout (hang detection);
// transport errors after boot are reported, not retried.
import http from "node:http";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const HOST = "127.0.0.1", TIMEOUT = 8000;
const results = [];

const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "w10fuzz-"));
const store = new RoomStore(join(dir, "room.sqlite"));
store.initialize(initialRoom("commons"));
const server = createRoomServer({ store });
await new Promise((resolve) => server.listen(0, HOST, resolve));
const PORT = server.address().port;
const ORIGIN = `http://${HOST}:${PORT}`;
console.log(`fuzz target: ${ORIGIN} (tmp ${dir})`);

function req(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ error: "TIMEOUT", method, path }), TIMEOUT);
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(t); resolve(r); } };
    const r = http.request({ host: HOST, port: PORT, method, path, headers }, (res) => {
      let n = 0; const chunks = [];
      res.on("data", (c) => { n += c.length; if (chunks.length < 4) chunks.push(c); });
      res.on("end", () => done({
        status: res.statusCode, bytes: n, method, path,
        head: Buffer.concat(chunks).toString("utf8", 0, 160).replace(/\s+/g, " "),
        ctype: res.headers["content-type"] || "",
      }));
      res.on("error", (e) => done({ error: e.code || e.message, method, path }));
    });
    r.on("error", (e) => done({ error: e.code || e.message, method, path }));
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
    s.on("end", () => { clearTimeout(t); resolve({ label, first: buf.slice(0, 80).replace(/\r/g, "\\r").replace(/\n/g, "\\n") }); });
    s.on("error", (e) => { clearTimeout(t); resolve({ label, error: e.code || e.message }); });
  });
}

function log(r) {
  results.push(r);
  const path = (r.path ?? r.label ?? "");
  const short = path.length > 110 ? path.slice(0, 110) + `…(${path.length})` : path;
  const s = r.status ?? r.error ?? r.first;
  const extra = r.status && r.head ? ` len=${r.bytes} [${r.head.slice(0, 90)}]` : "";
  console.log(`${r.method ?? ""} ${short} => ${s}${extra}`);
}

const GH = "/api/auth/github/start";
const GL = "/api/guest-agent-links";
const BIG = "x".repeat(7000);

const T = async () => {
  // ---- A. /api/auth/github/start : methods (expect GET→503, rest→405) ----
  for (const m of ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "FOOBAR"])
    log(await req(m, GH));
  // ---- A : path shapes (GET) ----
  for (const p of [
    GH + "/", GH + "//", GH.replace("github", "GITHUB"), GH.replace("start", "START"),
    "/api/auth/github/start%2f", "/api/auth/github%2fstart", "/api/auth/github/start%00",
    "/api/auth/github/start%00.json", "//api/auth/github/start", "/api//auth/github/start",
    "/api/./auth/github/start", "/api/../api/auth/github/start",
    "/%61pi/auth/github/start", "/api/auth/github/start?", "/api/auth/github/start?x=" + "y".repeat(40000),
    GH + BIG.slice(0, 4000), "/api/auth/github/start/..", "/api/auth/github/star",
    GH + "%c0%af", "/api/auth/github/start%252f",
  ]) log(await req("GET", p));
  // ---- A : query shapes ----
  for (const q of [
    "?sessionToken=abc", "?sessionToken=", "?sessionToken=" + BIG.slice(0, 20000),
    "?sessionToken=%zz", "?sessionToken=%00", "?sessionToken[]=1", "?sessionToken=1&sessionToken=2",
    "?SESSIONTOKEN=abc", "?" + "p".repeat(30000), "?sessionToken=%2e%2e",
  ]) log(await req("GET", GH + q));
  // ---- A : header shapes ----
  log(await req("GET", GH, { headers: { accept: "text/html" } }));
  log(await req("GET", GH, { headers: { accept: "text/html,application/json;q=0.1" } }));
  log(await req("GET", GH, { headers: { accept: "application/json" } }));
  log(await req("GET", GH, { headers: { origin: "http://evil.example" } }));
  log(await req("GET", GH, { headers: { origin: ORIGIN } }));
  log(await req("GET", GH, { headers: { cookie: "x".repeat(20000) } }));
  log(await req("GET", GH, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" } }));
  log(await req("GET", GH, { headers: { authorization: "Bearer <redacted>" } }));
  log(await req("POST", GH, { headers: { "content-type": "application/json" }, body: "{}" }));
  log(await req("POST", GH, { headers: { "content-type": "application/json" }, body: "[".repeat(10000) }));

  // ---- B. /api/guest-agent-links : methods (expect GET/HEAD→200; POST→401 row-60; others→fallthrough) ----
  for (const m of ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "FOOBAR"])
    log(await req(m, GL));
  // ---- B : path shapes (GET) ----
  for (const p of [
    GL + "/", GL + "//", GL.replace("guest-agent-links", "GUEST-AGENT-LINKS"),
    "/api/guest-agent-links%2f", "/api/guest-agent-links%00", "//api/guest-agent-links",
    "/api//guest-agent-links", "/%61pi/guest-agent-links", GL + "?" + "a=1&".repeat(50) + "b=2",
    GL + BIG.slice(0, 4000), GL + "%c0%af", "/api/guest-agent-link",
  ]) log(await req("GET", p));
  // ---- B : header shapes ----
  log(await req("GET", GL, { headers: { accept: "text/html" } }));
  log(await req("GET", GL, { headers: { origin: "http://evil.example" } }));
  log(await req("GET", GL, { headers: { origin: ORIGIN } }));
  log(await req("GET", GL, { headers: { cookie: "x".repeat(20000) } }));
  log(await req("POST", GL, { headers: { "content-type": "application/json" }, body: "{}" }));
  log(await req("PUT", GL, { headers: { "content-type": "application/json" }, body: "{}" }));
  log(await req("HEAD", GL + "/", {}));

  // ---- raw socket shapes ----
  const raws = [
    [`GARBAGE ${GH} HTTP/1.1\r\nHost: x\r\n\r\n`, "gh:garbage-verb"],
    [`GET ${GH} HTTP/1.0\r\n\r\n`, "gh:http10-no-host"],
    [`GET ${GH}\r\n\r\n`, "gh:no-version"],
    [`GET ` + GH.padEnd(9000, "x") + ` HTTP/1.1\r\nHost: x\r\n\r\n`, "gh:huge-target"],
    [`GET ${GH} HTTP/1.1\r\nHost: x\r\nX-Big: ` + "y".repeat(20000) + `\r\n\r\n`, "gh:huge-header"],
    [`GET ${GH} HTTP/1.1\r\nHost: x\r\nHost: y\r\n\r\n`, "gh:dup-host"],
    [`\x00GET ${GH} HTTP/1.1\r\nHost: x\r\n\r\n`, "gh:null-prefix"],
    [`GET /\x00api/auth/github/start HTTP/1.1\r\nHost: x\r\n\r\n`, "gh:null-in-target"],
    [`GET ${GL} HTTP/1.1\r\nHost: x\r\nCookie: ` + "q".repeat(30000) + `\r\n\r\n`, "gl:huge-cookie"],
    [`GET ${GL}%00 HTTP/1.1\r\nHost: x\r\n\r\n`, "gl:null-pct"],
    [`get ${GL} HTTP/1.1\r\nHost: x\r\n\r\n`, "gl:lowercase-verb"],
    [`GET ${GL} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`, "gl:chunked-get"],
  ];
  for (const [d, l] of raws) log(await raw(d, l));

  // ---- liveness: server still healthy? ----
  log(await req("GET", "/api/health"));

  console.log(`\nTOTAL: ${results.length}`);
  const timeouts = results.filter((r) => r.error === "TIMEOUT");
  const crashes = results.filter((r) => r.error && r.error !== "TIMEOUT" && !["ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(r.error));
  console.log("timeouts:", timeouts.length, JSON.stringify(timeouts.map((t) => `${t.method ?? ""} ${t.path ?? t.label}`)));
  console.log("transport-errors:", JSON.stringify(crashes.map((c) => `${c.method ?? ""} ${c.path ?? c.label} => ${c.error}`)));
};

await T();
server.close();
store.close?.();
process.exit(0);
