// WAVE-2000 guild-02 worker-1 API fuzzing: routes (index mod 50)==0 of sorted route list.
// Shard: /.well-known/security.txt, /api/auth/github/link/start, /api/updates
// Usage: W1_SECRET=<identity secret> node fuzz.mjs  (secret passed via env, never logged)
import { request } from "node:http";

const HOST = "127.0.0.1", PORT = Number(process.env.FUZZ_PORT || 42119);
const SECRET = process.env.W1_SECRET || "";

function call({ method = "GET", path, headers = {}, body = null, timeout = 8000 }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { req.destroy(); resolve({ timeout: true }); }, timeout);
    const req = request({ host: HOST, port: PORT, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          allow: res.headers.allow || null,
          contentType: res.headers["content-type"] || null,
          bodyLen: buf.length,
          bodyHead: buf.slice(0, 120).toString("utf8").replace(/\s+/g, " "),
        });
      });
    });
    req.on("error", (e) => { clearTimeout(timer); resolve({ error: e.code || e.message }); });
    if (body) req.write(body);
    req.end();
  });
}

const auth = { Authorization: `Bearer ${SECRET}` };
const cases = [];
const C = (name, opts, expect) => cases.push({ name, opts, expect });

const SEC = ["/.well-known/security.txt", "/security.txt", "/room/.well-known/security.txt"];
for (const p of SEC) {
  C(`sec GET ${p}`, { path: p }, 404);
  C(`sec HEAD ${p}`, { method: "HEAD", path: p }, 404);
  C(`sec POST ${p}`, { method: "POST", path: p }, 405);
  C(`sec PUT ${p}`, { method: "PUT", path: p }, 405);
  C(`sec DELETE ${p}`, { method: "DELETE", path: p }, 405);
  C(`sec OPTIONS ${p}`, { method: "OPTIONS", path: p }, 405);
  C(`sec PATCH ${p}`, { method: "PATCH", path: p }, 405);
}
C("sec GET trailing slash", { path: "/.well-known/security.txt/" }, 404);
C("sec GET double slash", { path: "//.well-known//security.txt" }, 404);
C("sec GET query", { path: "/.well-known/security.txt?x=1" }, 404);
C("sec GET case", { path: "/.WELL-KNOWN/SECURITY.TXT" }, 404);
C("sec GET dotdot", { path: "/x/../.well-known/security.txt" }, 404);

const GH = "/api/auth/github/link/start";
C("gh GET anon", { path: GH }, 401);
C("gh HEAD anon", { method: "HEAD", path: GH }, 405);
C("gh POST anon", { method: "POST", path: GH }, 405);
C("gh PUT anon", { method: "PUT", path: GH }, 405);
C("gh DELETE anon", { method: "DELETE", path: GH }, 405);
C("gh PATCH anon", { method: "PATCH", path: GH }, 405);
C("gh OPTIONS anon", { method: "OPTIONS", path: GH }, 405);
C("gh GET trailing slash", { path: GH + "/" }, 401);
C("gh GET junk bearer", { path: GH, headers: { Authorization: "Bearer garbage-token" } }, 401);
C("gh GET identity bearer (not account)", { path: GH, headers: auth }, 401);
C("gh GET huge query", { path: GH + "?q=" + "a".repeat(8000) }, 401);
C("gh GET junk cookie", { path: GH, headers: { Cookie: "sess=" + "x".repeat(2000) } }, 401);

const UP = "/api/updates";
C("up GET anon", { path: UP }, 401);
C("up HEAD anon", { method: "HEAD", path: UP }, 401);
C("up POST anon", { method: "POST", path: UP }, 405);
C("up PUT anon", { method: "PUT", path: UP }, 405);
C("up DELETE anon", { method: "DELETE", path: UP }, 405);
C("up OPTIONS anon", { method: "OPTIONS", path: UP }, 405);
C("up GET garbage bearer", { path: UP, headers: { Authorization: "Bearer not-a-secret" } }, 401);
C("up GET bare bearer", { path: UP, headers: { Authorization: "Bearer" } }, 401);
C("up GET basic", { path: UP, headers: { Authorization: "Basic eA==" } }, 401);
if (SECRET) {
  C("up GET authed", { path: UP, headers: auth }, 200);
  C("up HEAD authed", { method: "HEAD", path: UP, headers: auth }, 200);
  C("up GET limit=50", { path: UP + "?limit=50", headers: auth }, 200);
  C("up GET limit=abc", { path: UP + "?limit=abc", headers: auth }, 422);
  C("up GET limit=-1", { path: UP + "?limit=-1", headers: auth }, 422);
  C("up GET limit=0", { path: UP + "?limit=0", headers: auth }, 422);
  C("up GET limit=1.5", { path: UP + "?limit=1.5", headers: auth }, 422);
  C("up GET limit=huge", { path: UP + "?limit=99999999999999999999999", headers: auth }, 422);
  C("up GET limit=101", { path: UP + "?limit=101", headers: auth }, 422);
  C("up GET limit=Infinity", { path: UP + "?limit=Infinity", headers: auth }, 422);
  C("up GET limit dup", { path: UP + "?limit=1&limit=2", headers: auth }, 422);
  C("up GET bogus param", { path: UP + "?bogus=1", headers: auth }, 422);
  C("up GET state=all", { path: UP + "?state=all", headers: auth }, 200);
  C("up GET state=bogus", { path: UP + "?state=bogus", headers: auth }, 422);
  C("up GET kinds=request", { path: UP + "?kinds=request", headers: auth }, 200);
  C("up GET kinds=nope", { path: UP + "?kinds=nope", headers: auth }, 422);
  C("up GET kinds giant", { path: UP + "?kinds=" + "x".repeat(100000), headers: auth }, 422);
  C("up GET cursor=junk", { path: UP + "?cursor=!!!not-base64!!!", headers: auth }, 422);
  C("up GET cursor=v2shape", { path: UP + "?cursor=" + Buffer.from(JSON.stringify({ v: 2, viewer: "identity:x", createdAt: "2026-01-01T00:00:00Z", id: "y" })).toString("base64url"), headers: auth }, 422);
  C("up GET state giant", { path: UP + "?state=" + "a".repeat(10000), headers: auth }, 422);
  C("up GET empty limit", { path: UP + "?limit=", headers: auth }, 422);
  C("up GET huge body (framed)", { path: UP, headers: { ...auth, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(JSON.stringify({ x: "y".repeat(500000) }))) }, body: JSON.stringify({ x: "y".repeat(500000) }) }, 200);
  C("up GET small body (framed)", { path: UP, headers: { ...auth, "Content-Type": "application/json", "Content-Length": "7" }, body: '{"x":1}' }, 200);
}

const results = [];
let anomalous = 0;
for (const c of cases) {
  const r = await call(c.opts);
  const ok = r.timeout ? false : (c.expect === null ? (r.status >= 200 && r.status < 600 && r.status !== 500) : r.status === c.expect);
  if (!ok) anomalous++;
  results.push({ name: c.name, expect: c.expect, got: r.timeout ? "TIMEOUT" : (r.error ? `ERR:${r.error}` : r.status), ok, allow: r.allow, bodyLen: r.bodyLen ?? 0, bodyHead: r.bodyHead ?? "" });
}

// liveness probe after everything
const alive = await call({ path: "/api/health" });
results.push({ name: "liveness /api/health after fuzz", expect: 200, got: alive.status, ok: alive.status === 200 });

const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./fuzz-results.json", import.meta.url), JSON.stringify({ cases: results, anomalous }, null, 1));
console.log(`total=${results.length} anomalous=${anomalous}`);
for (const r of results) if (!r.ok) console.log(`ANOMALY name=${r.name} expect=${r.expect} got=${r.got} allow=${r.allow} bodyLen=${r.bodyLen} bodyHead=${r.bodyHead}`);
