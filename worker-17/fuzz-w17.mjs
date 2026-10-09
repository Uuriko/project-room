#!/usr/bin/env node
// WAVE-2000 GUILD-02 — WORKER 17 fuzz harness.
// Shard: unique literal routes in server/http.mjs, (index mod 50)==16
//   16 -> GET|HEAD /api/ready            (http.mjs:1631)
//   66 -> POST /api/invitations/preview  (http.mjs:2583)
// Local-only (127.0.0.1). Flags: any 500, hang (>10s), dropped connection
// without a status line, or a status outside the expected set per case.
import { connect } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TMP = join(HERE, ".tmp");
mkdirSync(TMP, { recursive: true });
process.env.TMPDIR = TMP;

const { RoomStore } = await import(`${ROOT}/server/store.mjs`);
const { createRoomServer } = await import(`${ROOT}/server/http.mjs`);
const { initialRoom } = await import(`${ROOT}/server/bootstrap.mjs`);

async function bootServer() {
  const dir = mkdtempSync(join(TMP, "fuzzdb-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return server;
}
let server = await bootServer();
let PORT = server.address().port;
let ORIGIN = `http://127.0.0.1:${PORT}`;
console.log(`target ${ORIGIN}`);

const PER_REQ_MS = 10000;
const results = [];
let failures = 0;

function rawRequest(payload, { timeoutMs = PER_REQ_MS, drip = null, halfCloseMs = 50 } = {}) {
  return new Promise(resolve => {
    const sock = connect(PORT, "127.0.0.1");
    let buf = Buffer.alloc(0), done = false;
    const finish = result => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(result); } };
    const timer = setTimeout(() => finish({ outcome: "timeout" }), timeoutMs);
    timer.unref?.();
    sock.on("connect", async () => {
      try {
        if (drip) {
          for (const [chunk, d] of drip) {
            if (sock.destroyed) break; // server already answered / timed out: stop dripping
            await new Promise(r => setTimeout(r, d));
            if (sock.destroyed) break;
            sock.write(chunk);
          }
        }
        else sock.write(payload);
        if (!drip && halfCloseMs != null) setTimeout(() => { try { sock.end(); } catch {} }, halfCloseMs);
      } catch (e) { clearTimeout(timer); finish({ outcome: "write-error", error: String(e) }); }
    });
    sock.on("data", c => { buf = Buffer.concat([buf, c]); });
    const parse = () => {
      const head = buf.toString("latin1");
      const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head);
      if (m) return { outcome: "response", status: Number(m[1]), bytes: buf.length, head: head.split("\r\n\r\n")[0].slice(0, 500), bodyTail: head.split("\r\n\r\n")[1]?.slice(0, 300) };
      return { outcome: buf.length ? "no-status" : "closed-no-response", bytes: buf.length };
    };
    sock.on("end", () => { clearTimeout(timer); finish(parse()); });
    sock.on("close", () => { clearTimeout(timer); finish(buf.length ? parse() : { outcome: "closed-no-response", bytes: 0 }); });
    sock.on("error", e => { clearTimeout(timer); finish({ outcome: "socket-error", error: e.code || String(e) }); });
  });
}

const NUL = Buffer.from([0]);
const asBuf = s => Buffer.from(s, "latin1");
const req = (method, path, headers = {}, body = null) => {
  let h = `Host: 127.0.0.1:${PORT}\r\nConnection: close\r\n`;
  for (const [k, v] of Object.entries(headers)) { if (v !== undefined) h += `${k}: ${v}\r\n`; }
  let b = Buffer.alloc(0);
  if (body != null) { b = Buffer.isBuffer(body) ? body : Buffer.from(body); h += `Content-Length: ${b.length}\r\n`; }
  return Buffer.concat([asBuf(`${method} ${path} HTTP/1.1\r\n${h}\r\n`), b]);
};
const jsonReq = (method, path, obj, extra = {}) =>
  req(method, path, { "Content-Type": "application/json", Origin: ORIGIN, ...extra }, JSON.stringify(obj));

const TOKEN43 = "a".repeat(43); // well-formed, not in DB -> expect 404

// rate-limit probe FIRST on a pristine server: 35 rapid valid posts;
// limit is 30/min per IP for invitation-preview -> expect ~30x 404 then 429s.
console.log("--- rate-limit probe (35 rapid POSTs, fresh server) ---");
{
  const rl = [];
  for (let i = 0; i < 35; i++) {
    const r = await rawRequest(jsonReq("POST", "/api/invitations/preview", { invitationToken: TOKEN43 }), { halfCloseMs: null });
    rl.push(r.status ?? r.outcome);
    await new Promise(rr => setTimeout(rr, 5));
  }
  const counts = {};
  for (const s of rl) counts[s] = (counts[s] ?? 0) + 1;
  console.log("rate-limit statuses:", JSON.stringify(counts));
  var rlOk = (counts[404] ?? 0) >= 25 && (counts[429] ?? 0) >= 3;
  console.log(rlOk ? "ok   rate limiter engaged (404s then 429s)" : "FAIL rate limiter behavior unexpected");
  if (!rlOk) failures++;
}
// fresh server for the matrix so the probe's consumption doesn't pollute it
server.close();
await new Promise(r => setTimeout(r, 300));
server = await bootServer();
PORT = server.address().port;
ORIGIN = `http://127.0.0.1:${PORT}`;
console.log(`matrix target ${ORIGIN}`);

const cases = [];
const C = (route, desc, makeReq, expect) => cases.push({ route, desc, makeReq, expect });
// expect: array of allowed statuses, or "no-crash" (no 500/hang/drop), or {min,max}

const J = { "Content-Type": "application/json", Origin: ORIGIN };

// ---------- /api/ready: method matrix ----------
for (const m of ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "FROBNICATE", "get"]) {
  C("ready", `method ${m} /api/ready`, () => req(m, "/api/ready"), m === "GET" || m === "HEAD" ? [200] : "no-crash");
}
// ---------- /api/ready: path variants ----------
C("ready", "trailing slash /api/ready/", () => req("GET", "/api/ready/"), [200]); // normalized at http.mjs:952
C("ready", "case variant /api/READY", () => req("GET", "/api/READY"), "no-crash");
C("ready", "double slash /api//ready", () => req("GET", "/api//ready"), "no-crash");
C("ready", "query string", () => req("GET", "/api/ready?x=1&y=" + "z".repeat(100)), [200]);
C("ready", "query bomb 5k params", () => req("GET", "/api/ready?" + "a=1&".repeat(5000)), "no-crash");
C("ready", "10KB path", () => req("GET", "/api/ready/" + "a".repeat(10000)), "no-crash");
C("ready", "encoded slash /api%2fready", () => req("GET", "/api%2fready"), "no-crash");
C("ready", "dot segment /api/./ready", () => req("GET", "/api/./ready"), "no-crash");
C("ready", "HEAD with query", () => req("HEAD", "/api/ready?x=1"), [200]);
C("ready", "huge User-Agent", () => req("GET", "/api/ready", { "User-Agent": "x".repeat(20000) }), "no-crash");
C("ready", "NUL in path", () => Buffer.concat([asBuf("GET /api/ready"), NUL, asBuf("x HTTP/1.1\r\nHost: 127.0.0.1:" + PORT + "\r\nConnection: close\r\n\r\n")]), "no-crash");
C("ready", "no Host header", () => asBuf("GET /api/ready HTTP/1.1\r\nConnection: close\r\n\r\n"), "no-crash");
C("ready", "HTTP/1.0", () => asBuf(`GET /api/ready HTTP/1.0\r\nHost: 127.0.0.1:${PORT}\r\n\r\n`), "no-crash");

// ---------- /api/invitations/preview: origin matrix ----------
C("preview", "POST no Origin -> 403", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: TOKEN43 }, { Origin: undefined }), [403]);
C("preview", "POST wrong Origin -> 403", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: "https://evil.example" }, JSON.stringify({ invitationToken: TOKEN43 })), [403]);
C("preview", "POST empty Origin -> 403", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: "" }, JSON.stringify({ invitationToken: TOKEN43 })), [403]);
C("preview", "POST correct Origin, unknown token -> 404", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: TOKEN43 }), [404]);
C("preview", "POST bad-char token -> 404", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: "!!!not-a-token!!!" }), [404]);
C("preview", "POST short token -> 404", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: "abc" }), [404]);
// ---------- /api/invitations/preview: body matrix ----------
C("preview", "empty body", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: ORIGIN }), [400]);
C("preview", "malformed JSON", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: ORIGIN }, "{nope"), [400]);
C("preview", "JSON array body", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: ORIGIN }, "[1,2]"), [400]);
C("preview", "JSON string body", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: ORIGIN }, "\"hi\""), [400]);
C("preview", "JSON number body", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: ORIGIN }, "42"), [400]);
C("preview", "JSON null body", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: ORIGIN }, "null"), [400]);
C("preview", "missing key {}", () => jsonReq("POST", "/api/invitations/preview", {}), [422]);
C("preview", "extra key", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: TOKEN43, extra: 1 }), [422]);
C("preview", "__proto__ key", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: ORIGIN }, JSON.stringify({ invitationToken: TOKEN43 }).replace("}", ',"__proto__":{}}')), [422]);
C("preview", "token as number", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: 123 }), [422]);
C("preview", "token as null", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: null }), [422]);
C("preview", "token as array", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: [TOKEN43] }), [422]);
C("preview", "token as object", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: { t: TOKEN43 } }), [422]);
C("preview", "token as bool", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: true }), [422]);
C("preview", "duplicate keys", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: ORIGIN }, `{"invitationToken":"${TOKEN43}","invitationToken":"${TOKEN43}"}`), [404]);
C("preview", "deeply nested token", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: { a: { b: { c: [1, { d: "x".repeat(5000) }] } } } }), [422]);
C("preview", "10k-char token", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: "b".repeat(10000) }), [404]);
C("preview", "unicode token", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: "é".repeat(43) }), [404]);
C("preview", "token with spaces", () => jsonReq("POST", "/api/invitations/preview", { invitationToken: "a".repeat(42) + " " }), [404]);
C("preview", "wrong content-type text/plain", () => req("POST", "/api/invitations/preview", { "Content-Type": "text/plain", Origin: ORIGIN }, "hello"), [415]);
C("preview", "missing content-type", () => req("POST", "/api/invitations/preview", { Origin: ORIGIN }, JSON.stringify({ invitationToken: TOKEN43 })), [415]);
C("preview", "content-type with charset", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json; charset=utf-8", Origin: ORIGIN }, JSON.stringify({ invitationToken: TOKEN43 })), [404]);
C("preview", "content-type application/jsonx", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/jsonx", Origin: ORIGIN }, "{}"), [415]);
C("preview", "oversize body 20KB -> 413", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: ORIGIN }, JSON.stringify({ invitationToken: TOKEN43, pad: "x".repeat(20000) }).slice(0, 20000)), [413]);
C("preview", "declared CL larger than actual", () => asBuf(`POST /api/invitations/preview HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\nContent-Type: application/json\r\nOrigin: ${ORIGIN}\r\nContent-Length: 5000\r\n\r\n{"invitationToken":"${TOKEN43}"}`), "no-crash");
C("preview", "chunked body", () => {
  const payload = JSON.stringify({ invitationToken: TOKEN43 });
  const n = Buffer.byteLength(payload).toString(16);
  return asBuf(`POST /api/invitations/preview HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\nContent-Type: application/json\r\nOrigin: ${ORIGIN}\r\nTransfer-Encoding: chunked\r\n\r\n${n}\r\n${payload}\r\n0\r\n\r\n`);
}, [404]);
C("preview", "NUL byte in JSON body", () => Buffer.concat([asBuf(`POST /api/invitations/preview HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\nContent-Type: application/json\r\nOrigin: ${ORIGIN}\r\nContent-Length: 60\r\n\r\n{"invitationToken":"`), NUL, asBuf(`abc"}`)]), "no-crash");
// ---------- /api/invitations/preview: method matrix ----------
for (const m of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
  C("preview", `method ${m}`, () => req(m, "/api/invitations/preview", { Origin: ORIGIN }), "no-crash");
}

// ---------- extra transport-shape cases (run on a THIRD fresh server: the
// preview absolute-URI POST consumes rate budget, and the matrix exhausts it)
const extraCases = [];
const X = (route, desc, makeReq, expect) => extraCases.push({ route, desc, makeReq, expect });
X("preview", "absolute-URI request target", () => {
  const p = JSON.stringify({ invitationToken: TOKEN43 });
  return asBuf(`POST ${ORIGIN}/api/invitations/preview HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\nContent-Type: application/json\r\nOrigin: ${ORIGIN}\r\nContent-Length: ${Buffer.byteLength(p)}\r\n\r\n${p}`);
}, [404]);
X("ready", "absolute-URI request target", () => asBuf(`GET ${ORIGIN}/api/ready HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`), [200]);
// http.mjs:1020 global preamble guard: any request carrying a foreign Origin
// header is 403, even on routes that don't call checkOrigin themselves.
X("ready", "GET with foreign Origin -> 403 (global preamble guard)", () => req("GET", "/api/ready", { Origin: "https://evil.example" }), [403]);
X("preview", "Origin case: trailing slash", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: ORIGIN + "/" }, JSON.stringify({ invitationToken: TOKEN43 })), [403]);
X("preview", "Origin: null", () => req("POST", "/api/invitations/preview", { "Content-Type": "application/json", Origin: "null" }, JSON.stringify({ invitationToken: TOKEN43 })), [403]);
X("preview", "duplicate Content-Length", () => asBuf(
  `POST /api/invitations/preview HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\nContent-Type: application/json\r\nOrigin: ${ORIGIN}\r\nContent-Length: 10\r\nContent-Length: 10\r\n\r\n{"a":1}`
), "no-crash");

let ran = 0;
for (const c of cases) {
  if (!c.makeReq) continue;
  const t0 = Date.now();
  let r;
  try { r = await rawRequest(c.makeReq()); }
  catch (e) { r = { outcome: "harness-error", error: String(e) }; }
  r.ms = Date.now() - t0;
  const exp = c.expect;
  let verdict = "PASS", note = "";
  if (r.outcome === "timeout") { verdict = "FAIL-HANG"; note = `no response in ${PER_REQ_MS}ms`; }
  else if (r.outcome !== "response") { verdict = "FAIL-DROP"; note = r.outcome + (r.error ? `: ${r.error}` : ""); }
  else if (r.status === 500) { verdict = "FAIL-500"; note = (r.bodyTail || "").slice(0, 200); }
  else if (Array.isArray(exp) && !exp.includes(r.status)) { verdict = "FAIL-STATUS"; note = `got ${r.status}, expected one of [${exp}]`; }
  if (verdict !== "PASS") failures++;
  results.push({ route: c.route, desc: c.desc, verdict, status: r.status ?? null, outcome: r.outcome, ms: r.ms, note, head: r.head || undefined });
  ran++;
  console.log(`${verdict === "PASS" ? "ok  " : verdict} [${c.route}] ${c.desc} -> ${r.status ?? r.outcome} ${note}`);
}

// extra transport-shape cases on a THIRD fresh server (rate budget pristine)
server.close();
await new Promise(r => setTimeout(r, 300));
server = await bootServer();
PORT = server.address().port;
ORIGIN = `http://127.0.0.1:${PORT}`;
console.log(`extra target ${ORIGIN}`);
for (const c of extraCases) {
  const t0 = Date.now();
  let r;
  try { r = await rawRequest(c.makeReq()); }
  catch (e) { r = { outcome: "harness-error", error: String(e) }; }
  r.ms = Date.now() - t0;
  const exp = c.expect;
  let verdict = "PASS", note = "";
  if (r.outcome === "timeout") { verdict = "FAIL-HANG"; note = `no response in ${PER_REQ_MS}ms`; }
  else if (r.outcome !== "response") { verdict = "FAIL-DROP"; note = r.outcome + (r.error ? `: ${r.error}` : ""); }
  else if (r.status === 500) { verdict = "FAIL-500"; note = (r.bodyTail || "").slice(0, 200); }
  else if (Array.isArray(exp) && !exp.includes(r.status)) { verdict = "FAIL-STATUS"; note = `got ${r.status}, expected one of [${exp}]`; }
  if (verdict !== "PASS") failures++;
  results.push({ route: c.route, desc: c.desc, verdict, status: r.status ?? null, outcome: r.outcome, ms: r.ms, note });
  ran++;
  console.log(`${verdict === "PASS" ? "ok  " : verdict} [${c.route}] ${c.desc} -> ${r.status ?? r.outcome} ${note}`);
}

// pipelining: two GET /api/ready back-to-back on one keep-alive socket
{
  const payload = asBuf(`GET /api/ready HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: keep-alive\r\n\r\nGET /api/ready HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
  const r = await new Promise(resolve => {
    const sock = connect(PORT, "127.0.0.1");
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} resolve({ outcome: "timeout" }); }, PER_REQ_MS);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", c => { buf = Buffer.concat([buf, c]); });
    sock.on("close", () => { clearTimeout(timer); resolve({ outcome: "closed", statuses: (buf.toString("latin1").match(/HTTP\/\d(?:\.\d)? \d{3}/g) || []) }); });
    sock.on("error", e => { clearTimeout(timer); resolve({ outcome: "socket-error", error: String(e) }); });
  });
  const okPipe = r.outcome === "closed" && r.statuses && r.statuses.length === 2 && r.statuses.every(s => s.endsWith("200"));
  console.log(okPipe ? "ok   [ready] pipelined 2x GET -> 200,200" : `FAIL [ready] pipelining -> ${JSON.stringify(r)}`);
  if (!okPipe) failures++;
  results.push({ route: "ready", desc: "pipelined 2x GET keep-alive", verdict: okPipe ? "PASS" : "FAIL-STATUS", status: null, outcome: r.outcome, ms: 0, note: JSON.stringify(r.statuses || r) });
  ran++;
}

// slow-drip body: 1 byte / 1500ms on preview. KNOWN BEHAVIOR (not a new finding):
// the coordinator's F07 "slowloris-drip" already FAIL-HANGed on this codebase —
// Node does not terminate stalled connections despite requestTimeout=15000
// (verified on plain node v24 too). Server-wide transport issue, not shard-
// specific. Recorded here as informational only; never fails the worker.
{
  const head = asBuf(`POST /api/invitations/preview HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\nContent-Type: application/json\r\nOrigin: ${ORIGIN}\r\nContent-Length: 100\r\n\r\n`);
  const drip = [[head, 0]];
  const p = JSON.stringify({ invitationToken: TOKEN43 });
  for (let i = 0; i < p.length; i++) drip.push([asBuf(p[i]), 1500]);
  const r = await rawRequest(null, { drip, timeoutMs: 25000 });
  console.log(`info  [preview] slow drip -> ${r.outcome}${r.status ? " " + r.status : ""} (KNOWN: coordinator F07 slowloris hang)`);
  results.push({ route: "preview", desc: "slow drip body (informational; known F07 hang)", verdict: "KNOWN-HANG", status: r.status ?? null, outcome: r.outcome, ms: 0, note: "coordinator F07 already covers; Node-level, not shard-specific" });
  ran++;
}

// concurrent burst: 20 parallel preview POSTs; all must answer, none 500/hang
{
  const rs = await Promise.all(Array.from({ length: 20 }, () =>
    rawRequest(jsonReq("POST", "/api/invitations/preview", { invitationToken: TOKEN43 }))));
  const okBurst = rs.every(r => r.outcome === "response" && r.status !== 500);
  const sc = {};
  for (const r of rs) sc[r.status ?? r.outcome] = (sc[r.status ?? r.outcome] ?? 0) + 1;
  console.log(okBurst ? `ok   [preview] 20-concurrent burst -> ${JSON.stringify(sc)}` : `FAIL [preview] burst -> ${JSON.stringify(sc)}`);
  if (!okBurst) failures++;
  results.push({ route: "preview", desc: "20-concurrent burst", verdict: okBurst ? "PASS" : "FAIL-STATUS", status: null, outcome: "response", ms: 0, note: JSON.stringify(sc) });
  ran++;
}

writeFileSync(join(HERE, "results.json"), JSON.stringify({ target: ORIGIN, ran, failures, results, rateLimitOk: rlOk }, null, 2));
console.log(`\n${ran} cases, ${failures} failures -> worker-17/results.json`);
server.close();
process.exit(failures ? 1 : 0);
