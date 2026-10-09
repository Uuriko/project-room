// WORKER 9 shard fuzz — guild-02 (server/http.mjs), shard indexes 8 and 58 of 107
// exact-match `pathname === ` dispatch branches (0-based).
//   idx 8  -> line 1090: GET /api/auth/gmail/callback
//   idx 58 -> line 2368: GET /api/account/onboarding
// Mission: crash / hang / wrong-status. Every case records an EXPECTED status;
// deviations are findings. Rate-limit bursts run last to avoid poisoning the bucket.
import http from "node:http";
import net from "node:net";

const HOST = "127.0.0.1";
const PORT = 4239;
const BASE = `http://${HOST}:${PORT}`;

function request({ method = "GET", path = "/", headers = {}, body = null, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request(BASE + path, { method, headers: { Host: `${HOST}:${PORT}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        ok: true, status: res.statusCode, contentType: res.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - t0,
      }));
    });
    req.on("error", (e) => resolve({ ok: false, error: `conn:${e.code || e.message}`, ms: Date.now() - t0 }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: "TIMEOUT(hang)", ms: Date.now() - t0 }); });
    if (body) req.write(body);
    req.end();
  });
}

function rawSocket(payload) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect(PORT, HOST, () => s.write(payload));
    let data = "";
    s.on("data", (c) => { data += c.toString("latin1"); });
    s.on("close", () => resolve({ closed: true, firstLine: data.split("\r\n")[0], ms: Date.now() - t0 }));
    s.on("error", (e) => resolve({ closed: true, error: e.code, ms: Date.now() - t0 }));
    setTimeout(() => { s.destroy(); resolve({ closed: true, error: "TIMEOUT", ms: Date.now() - t0 }); }, 8000);
  });
}

const CASES = [
  // --- /api/auth/gmail/callback (gmail integration disabled locally: ROOM_GMAIL_ENABLED=0) ---
  { name: "gmailcb plain", path: "/api/auth/gmail/callback", expect: 200 },
  { name: "gmailcb trailing slash", path: "/api/auth/gmail/callback/", expect: 200 },
  { name: "gmailcb code+state", path: "/api/auth/gmail/callback?code=abc123&state=xyz", expect: 200 },
  { name: "gmailcb error param", path: "/api/auth/gmail/callback?error=access_denied&error_description=no", expect: 200 },
  { name: "gmailcb xss in code", path: "/api/auth/gmail/callback?code=%3Cscript%3Ealert(1)%3C/script%3E", expect: 200, check: (r) => !r.body.includes("<script>alert") },
  { name: "gmailcb long query", path: "/api/auth/gmail/callback?x=" + "a".repeat(8000), expect: 200 },
  { name: "gmailcb invalid pct", path: "/api/auth/gmail/callback?code=%ff%fe", expect: 200 },
  { name: "gmailcb unicode tail", path: "/api/auth/gmail/callback/%E2%82%AC", expect: 404 },
  { name: "gmailcb double slash", path: "/api/auth//gmail/callback", expect: 404 },
  { name: "gmailcb cookie garbage", path: "/api/auth/gmail/callback", headers: { Cookie: "gmail_oauth=garbage-value" }, expect: 200 },
  { name: "gmailcb cookie long", path: "/api/auth/gmail/callback", headers: { Cookie: "gmail_oauth=" + "x".repeat(8000) }, expect: 200 },
  { name: "gmailcb cookie special", path: "/api/auth/gmail/callback", headers: { Cookie: "gmail_oauth=a;b=c; d=e" }, expect: 200 },
  { name: "gmailcb cookie dup", path: "/api/auth/gmail/callback", headers: { Cookie: "gmail_oauth=a; gmail_oauth=b" }, expect: 401 },
  { name: "gmailcb many cookies", path: "/api/auth/gmail/callback", headers: { Cookie: Array.from({ length: 100 }, (_, i) => `c${i}=v${i}`).join("; ") }, expect: 200 },
  { name: "gmailcb POST", method: "POST", path: "/api/auth/gmail/callback", expect: 404 },
  { name: "gmailcb PUT", method: "PUT", path: "/api/auth/gmail/callback", expect: 404 },
  { name: "gmailcb DELETE", method: "DELETE", path: "/api/auth/gmail/callback", expect: 404 },
  { name: "gmailcb PATCH", method: "PATCH", path: "/api/auth/gmail/callback", expect: 404 },
  { name: "gmailcb HEAD", method: "HEAD", path: "/api/auth/gmail/callback", expect: 404 },
  { name: "gmailcb OPTIONS", method: "OPTIONS", path: "/api/auth/gmail/callback", expect: 404 },
  { name: "gmailcb weird accept", path: "/api/auth/gmail/callback", headers: { Accept: "text/html" }, expect: 200 },
  { name: "gmailcb json accept", path: "/api/auth/gmail/callback", headers: { Accept: "application/json" }, expect: 200 },
  // --- /api/account/onboarding ---
  { name: "onboarding plain", path: "/api/account/onboarding", expect: 401 },
  { name: "onboarding trailing slash", path: "/api/account/onboarding/", expect: 401 },
  { name: "onboarding query", path: "/api/account/onboarding?foo=bar", expect: 401 },
  { name: "onboarding garbage cookie", path: "/api/account/onboarding", headers: { Cookie: "account_session=garbage-session-token" }, expect: 401 },
  { name: "onboarding long cookie", path: "/api/account/onboarding", headers: { Cookie: "account_session=" + "y".repeat(8000) }, expect: 401 },
  { name: "onboarding dup cookie", path: "/api/account/onboarding", headers: { Cookie: "account_session=a; account_session=b" }, expect: 401 },
  { name: "onboarding empty cookie", path: "/api/account/onboarding", headers: { Cookie: "account_session=" }, expect: 401 },
  { name: "onboarding POST", method: "POST", path: "/api/account/onboarding", expect: 405 },
  { name: "onboarding PUT", method: "PUT", path: "/api/account/onboarding", expect: 405 },
  { name: "onboarding DELETE", method: "DELETE", path: "/api/account/onboarding", expect: 405 },
  { name: "onboarding HEAD", method: "HEAD", path: "/api/account/onboarding", expect: 405 },
  { name: "onboarding OPTIONS", method: "OPTIONS", path: "/api/account/onboarding", expect: 405 },
];

const cookieName = "account_session"; // http.mjs:115; origin is http:// so no __Host- prefix

async function main() {
  const findings = [];
  const results = [];
  for (const c of CASES) {
    const r = await request(c);
    const hang = !r.ok && r.error === "TIMEOUT(hang)";
    const crash = r.ok && r.status >= 500;
    let pass = true, note = "";
    if (hang) { pass = false; note = "HANG"; }
    else if (!r.ok) { pass = false; note = `CONN-ERR ${r.error}`; }
    else if (crash) { pass = false; note = `CRASH status=${r.status}`; }
    else if (r.status !== c.expect) { pass = false; note = `WRONG-STATUS got=${r.status} want=${c.expect}`; }
    else if (c.check && !c.check(r)) { pass = false; note = "CHECK-FAILED (xss echo?)"; }
    results.push({ name: c.name, status: r.ok ? r.status : r.error, ct: r.contentType, ms: r.ms, bodyHead: (r.body || "").slice(0, 120).replace(/\s+/g, " "), pass, note });
    if (!pass) findings.push({ case: c.name, note, method: c.method || "GET", path: c.path });
    console.log(`${pass ? "ok  " : "FAIL"} ${String(r.ok ? r.status : r.error).padEnd(12)} ${r.ms}ms ${c.name} ${note}`);
  }
  // raw socket: missing Host header -> node http layer responds 400 (not app code)
  const raw1 = await rawSocket("GET /api/auth/gmail/callback HTTP/1.1\r\nConnection: close\r\n\r\n");
  console.log(`raw missing-host: ${JSON.stringify(raw1)}`);
  // raw socket: unparseable request target "//" -> app maps to 400 invalid_request (QA 2026-10-04)
  const raw2 = await rawSocket(`GET // HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nConnection: close\r\n\r\n`);
  console.log(`raw double-slash-target: ${JSON.stringify(raw2)}`);
  // rate burst LAST: 25 rapid GETs; bucket max 20/min -> expect 200x20 then 429
  const burst = [];
  for (let i = 0; i < 25; i++) burst.push(request({ path: "/api/auth/gmail/callback" }));
  const bres = await Promise.all(burst);
  const counts = {};
  for (const r of bres) { const k = r.ok ? String(r.status) : r.error; counts[k] = (counts[k] || 0) + 1; }
  console.log(`rate burst statuses: ${JSON.stringify(counts)}`);
  const ok429 = (counts["429"] || 0) >= 4 && (counts["200"] || 0) >= 19;
  console.log(ok429 ? "ok   rate-limit enforced" : "FAIL rate-limit NOT enforced as expected");
  if (!ok429) findings.push({ case: "gmailcb rate burst", note: `expected ~20x200+429s, got ${JSON.stringify(counts)}` });
  console.log(`\nFINDINGS: ${findings.length}`);
  for (const f of findings) console.log(` - ${f.case}: ${f.note}`);
  const fs = await import("node:fs");
  fs.writeFileSync(new URL("./fuzz-results.json", import.meta.url),
    JSON.stringify({ at: new Date().toISOString(), results, findings, rateBurst: counts }, null, 2));
}

main().catch((e) => { console.error("fuzz runner crashed:", e); process.exit(2); });
