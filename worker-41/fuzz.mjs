// WAVE-2000 guild-02 worker-41 fuzz harness.
// Shard: literal routes in server/http.mjs sorted by line, (index mod 50)==40:
//   index 40 -> server/http.mjs:2181 POST /api/auth/recovery-codes/redeem
//   index 90 -> server/http.mjs:3105 POST /api/access-requests
// NOTE: the task's literal `app.(get|post|...)` grep yields 0 matches in this
// codebase (routes dispatch via `if (url.pathname === ...)`); the route list
// was built from `url.pathname === "..."` literals instead. Deviation logged
// in report.md.
import http from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.WORKER41_OUT || here;
mkdirSync(outDir, { recursive: true });

const deepNest = (depth) => {
  let s = '{"k":';
  s += '{"k":'.repeat(depth) + "1" + "}".repeat(depth);
  return s + "}";
};

const REDEEM = "/api/auth/recovery-codes/redeem";
const ACCESS = "/api/access-requests";
const goodRedeem = JSON.stringify({ email: "a@b.co", code: "XXXX-XXXX", sessionRevision: 1, sessionToken: "bogus-slot-token-for-fuzz" });
const goodAccess = JSON.stringify({ roomId: "room-fuzz-1", identityId: "ident-fuzz-1", displayName: "Fuzz", requestedPermissions: ["read"] });

const PHASES = [
  { name: "A", desc: "redeem POST body fuzz (limit 10/min -> 9 cases)", cases: [
    { name: "A1-baseline-junk", method: "POST", path: REDEEM, origin: true, body: goodRedeem, expect: [401, 422] },
    { name: "A2-malformed-json", method: "POST", path: REDEEM, origin: true, body: "{not json", expect: [400] },
    { name: "A3-json-array", method: "POST", path: REDEEM, origin: true, body: "[1,2]", expect: [400] },
    { name: "A4-json-null", method: "POST", path: REDEEM, origin: true, body: "null", expect: [400] },
    { name: "A5-proto-pollution", method: "POST", path: REDEEM, origin: true,
      body: '{"__proto__":{"polluted":1},"email":"a@b.co","code":"x","sessionRevision":1,"sessionToken":"t"}', expect: [401, 422] },
    { name: "A6-deep-nest", method: "POST", path: REDEEM, origin: true, body: deepNest(300), expect: [400, 401, 422] },
    { name: "A7-missing-fields", method: "POST", path: REDEEM, origin: true, body: '{"email":"a@b.co"}', expect: [422] },
    { name: "A8-bad-types", method: "POST", path: REDEEM, origin: true,
      body: '{"email":["a@b.co"],"code":{},"sessionRevision":1.5,"sessionToken":"t"}', expect: [422] },
    { name: "A9-sessionRevision-huge", method: "POST", path: REDEEM, origin: true,
      body: '{"email":"a@b.co","code":"x","sessionRevision":9007199254740993,"sessionToken":"t"}', expect: [422] },
  ]},
  { name: "B", desc: "redeem headers/origin/methods (fresh rate bucket)", cases: [
    { name: "B1-no-origin", method: "POST", path: REDEEM, body: goodRedeem, expect: [403] },
    { name: "B2-foreign-origin", method: "POST", path: REDEEM, origin: "https://evil.example.com", body: goodRedeem, expect: [403] },
    { name: "B3-GET", method: "GET", path: REDEEM, origin: true, expect: [404, 405] },
    { name: "B4-PUT", method: "PUT", path: REDEEM, origin: true, body: goodRedeem, expect: [404, 405] },
    { name: "B5-null-byte-email", method: "POST", path: REDEEM, origin: true,
      body: '{"email":"a\\u0000@b.co","code":"x","sessionRevision":1,"sessionToken":"t"}', expect: [401, 422] },
    { name: "B6-huge-email", method: "POST", path: REDEEM, origin: true,
      body: JSON.stringify({ email: "a".repeat(12000) + "@b.co", code: "x", sessionRevision: 1, sessionToken: "t" }), expect: [401, 422] },
    { name: "B7-no-content-type", method: "POST", path: REDEEM, origin: true, noCT: true, body: goodRedeem, expect: [415] },
    { name: "B8-oversize", method: "POST", path: REDEEM, origin: true, body: JSON.stringify({ pad: "x".repeat(20000) }), expect: [413] },
    { name: "B9-empty-body", method: "POST", path: REDEEM, origin: true, body: "", expect: [400] },
  ]},
  { name: "C", desc: "access-requests POST body fuzz (limit 20/min -> 15 cases)", cases: [
    { name: "C1-baseline", method: "POST", path: ACCESS, body: goodAccess, expect: [201, 400, 404, 422] },
    { name: "C2-malformed-json", method: "POST", path: ACCESS, body: '{"roomId":', expect: [400] },
    { name: "C3-empty-body", method: "POST", path: ACCESS, body: "", expect: [400] },
    { name: "C4-missing-required", method: "POST", path: ACCESS, body: "{}", expect: [422] },
    { name: "C5-extra-field", method: "POST", path: ACCESS,
      body: JSON.stringify({ roomId: "r", identityId: "i", displayName: "d", requestedPermissions: [], admin: true }), expect: [422] },
    { name: "C6-null-note", method: "POST", path: ACCESS,
      body: JSON.stringify({ roomId: "r", identityId: "i", displayName: "d", requestedPermissions: [], note: null }), expect: [201, 400, 404, 422] },
    { name: "C7-bad-types", method: "POST", path: ACCESS,
      body: JSON.stringify({ roomId: 123, identityId: "i", displayName: "d", requestedPermissions: "read" }), expect: [422] },
    { name: "C8-large-permissions", method: "POST", path: ACCESS,
      body: JSON.stringify({ roomId: "r", identityId: "i", displayName: "d", requestedPermissions: Array.from({ length: 800 }, (_, i) => "p" + i) }), expect: [201, 400, 404, 422] },
    { name: "C9-proto-pollution", method: "POST", path: ACCESS,
      body: '{"__proto__":{"x":1},"roomId":"r","identityId":"i","displayName":"d","requestedPermissions":[]}', expect: [201, 400, 404, 422] },
    { name: "C10-deep-nested-perms", method: "POST", path: ACCESS,
      body: JSON.stringify({ roomId: "r", identityId: "i", displayName: "d", requestedPermissions: JSON.parse(deepNest(60)) }), expect: [201, 400, 404, 422] },
    { name: "C11-duplicate-requestId-1", method: "POST", path: ACCESS,
      body: JSON.stringify({ roomId: "r", identityId: "i", displayName: "d", requestedPermissions: [], requestId: "fuzz-dup-1" }), expect: [201, 400, 404, 422] },
    { name: "C12-duplicate-requestId-2", method: "POST", path: ACCESS,
      body: JSON.stringify({ roomId: "r", identityId: "i", displayName: "d", requestedPermissions: [], requestId: "fuzz-dup-1" }), expect: [201, 400, 404, 422] },
    { name: "C13-null-byte-roomId", method: "POST", path: ACCESS,
      body: '{"roomId":"r\\u0000x","identityId":"i","displayName":"d","requestedPermissions":[]}', expect: [201, 400, 404, 422] },
    { name: "C14-text-plain", method: "POST", path: ACCESS, contentType: "text/plain", body: goodAccess, expect: [415] },
    { name: "C15-bad-auth-header", method: "POST", path: ACCESS, headers: { authorization: "Bearer not-a-valid-token!!" }, body: goodAccess, expect: [401, 422] },
  ]},
  { name: "D", desc: "access-requests methods/paths (405 branch has no rate limit)", cases: [
    { name: "D1-GET", method: "GET", path: ACCESS, expect: [405] },
    { name: "D2-PUT", method: "PUT", path: ACCESS, expect: [405] },
    { name: "D3-DELETE", method: "DELETE", path: ACCESS, expect: [405] },
    { name: "D4-OPTIONS", method: "OPTIONS", path: ACCESS, expect: [405] },
    { name: "D5-HEAD", method: "HEAD", path: ACCESS, expect: [405] },
    { name: "D6-PATCH", method: "PATCH", path: ACCESS, expect: [405] },
    { name: "D7-trailing-slash-POST", method: "POST", path: ACCESS + "/", body: goodAccess, expect: [201, 400, 404, 422] },
    { name: "D8-double-slash", method: "GET", path: "/api//access-requests", expect: [400, 404, 405] },
    { name: "D9-query-junk", method: "POST", path: ACCESS + "?x=%00&y[]=%zz", body: goodAccess, expect: [201, 400, 404, 422] },
    { name: "D10-oversize", method: "POST", path: ACCESS, body: JSON.stringify({ pad: "x".repeat(20000) }), expect: [413] },
    { name: "D11-xff-spoof", method: "GET", path: ACCESS, headers: { "x-forwarded-for": "203.0.113.9, 70.41.3.20" }, expect: [405] },
    { name: "D12-host-mismatch", method: "GET", path: ACCESS, headers: { host: "evil.example.com" }, expect: [403] },
  ]},
];

function sendCase(port, origin, c) {
  return new Promise((resolve) => {
    const headers = { ...(c.headers || {}) };
    if (!("host" in headers)) headers.host = `127.0.0.1:${port}`;
    if (c.origin === true) headers.origin = origin;
    else if (typeof c.origin === "string") headers.origin = c.origin;
    const bodyBuf = c.body !== undefined ? Buffer.from(c.body, "utf8") : null;
    if (bodyBuf && !c.noCT && !headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = c.contentType || "application/json";
    const t0 = Date.now();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ ...r, ms: Date.now() - t0 }); } };
    const req = http.request({ host: "127.0.0.1", port, path: c.path, method: c.method, headers }, (res) => {
      let bytes = 0; const chunks = [];
      res.on("data", (ch) => { if (bytes < 512) chunks.push(ch); bytes += ch.length; });
      res.on("end", () => finish({ status: res.statusCode, respHeaders: res.headers, body: Buffer.concat(chunks).toString("utf8").slice(0, 400), bodyBytes: bytes }));
      res.on("error", (e) => finish({ status: "RESP-ERR", error: String(e.message || e).slice(0, 200) }));
    });
    req.on("timeout", () => { req.destroy(new Error("client-timeout")); });
    req.setTimeout(8000);
    req.on("error", (e) => finish({ status: e.message === "client-timeout" ? "HANG(8s client timeout)" : "REQ-ERR", error: String(e.message || e).slice(0, 200) }));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

const results = [];
let crashed = false;
process.on("uncaughtException", (e) => { crashed = true; console.error("UNCAUGHT:", e && e.stack ? e.stack.slice(0, 2000) : e); });

for (const phase of PHASES) {
  const dbDir = mkdtempSync(join(process.env.WORKER41_TMP || tmpdir(), `worker41-phase${phase.name}-`));
  const store = new RoomStore(join(dbDir, "room.db"));
  const server = createRoomServer({ store });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  console.log(`PHASE ${phase.name} on ${origin}: ${phase.desc}`);
  for (const c of phase.cases) {
    const r = await sendCase(port, origin, c);
    const ok = r.expect === undefined ? "?" : (c.expect.includes(r.status) ? "OK" : "UNEXPECTED");
    const line = { phase: phase.name, name: c.name, method: c.method, path: c.path, status: r.status,
      expected: c.expect, verdict: ok, ms: r.ms, body: r.body, error: r.error, crashed };
    results.push(line);
    console.log(`${ok} ${c.name} ${c.method} ${c.path} -> ${r.status} (${r.ms}ms)${r.body ? " " + r.body.slice(0, 120) : ""}${r.error ? " ERR:" + r.error : ""}`);
  }
  await new Promise((r) => { try { server.closeStreams(); server.closeAllConnections(); } catch {} server.close(r); });
  store.close();
}

const { writeFileSync } = await import("node:fs");
writeFileSync(join(outDir, "results.json"), JSON.stringify({ crashed, results }, null, 2));
const unexpected = results.filter((r) => r.verdict === "UNEXPECTED");
console.log(`\nDONE: ${results.length} cases, ${unexpected.length} unexpected${crashed ? ", SERVER CRASHED" : ""}`);
for (const u of unexpected) console.log("UNEXPECTED:", u.name, u.method, u.path, "->", u.status, "expected", u.expected, (u.body || "").slice(0, 160));
