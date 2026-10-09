// WAVE-2000 G02 WORKER 31 — API fuzzing
// Shard: 0-based route indexes (index mod 50)==30 over sorted
// `url.pathname === "/..."` dispatch lines in server/http.mjs (96 lines).
//   index 30 → http.mjs:1867  GET /templates | /templates.json
//   index 80 → http.mjs:2806  POST /api/referral-invites/mint
// (http.mjs uses raw-dispatcher if-blocks, not app.get(); this is the
// faithful equivalent of the task's app.(get|post|...) grep.)
import http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:18032";
const OUT = [];
const log = (name, method, path, status, ms, extra = "") =>
  OUT.push({ name, method, path: String(path).slice(0, 120), status, ms, extra: String(extra).slice(0, 300) });

function req(method, path, { headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = http.request(BASE + path, { method, headers, timeout }, (res) => {
      let n = 0; const chunks = [];
      res.on("data", (c) => { n += c.length; if (chunks.length < 4) chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - t0, bytes: n,
        ctype: res.headers["content-type"] || "", allow: res.headers.allow || "",
        head: Buffer.concat(chunks).toString("utf8", 0, 400) }));
    });
    r.on("timeout", () => { r.destroy(); resolve({ status: "TIMEOUT", ms: Date.now() - t0 }); });
    r.on("error", (e) => resolve({ status: "ERR:" + e.code, ms: Date.now() - t0, head: e.message.slice(0, 200) }));
    if (body !== null) r.write(body);
    r.end();
  });
}
const J = (o) => JSON.stringify(o);

async function main() {
  const T = "templates";
  // ---------- R1: GET /templates, /templates.json ----------
  let r = await req("GET", "/templates"); log(T, "GET", "/templates", r.status, r.ms, r.ctype);
  r = await req("GET", "/templates.json"); log(T, "GET", "/templates.json", r.status, r.ms, r.ctype + " bytes=" + r.bytes);
  r = await req("HEAD", "/templates"); log(T, "HEAD", "/templates", r.status, r.ms);
  r = await req("HEAD", "/templates.json"); log(T, "HEAD", "/templates.json", r.status, r.ms);
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    r = await req(m, "/templates"); log(T, m, "/templates", r.status, r.ms, r.allow);
  }
  r = await req("POST", "/templates.json", { headers: { "content-type": "application/json" }, body: J({}) });
  log(T, "POST", "/templates.json", r.status, r.ms);
  // query-param fuzz
  r = await req("GET", "/templates?ref=" + "A".repeat(5000)); log(T, "GET", "/templates?ref=5k", r.status, r.ms);
  r = await req("GET", "/templates.json?ref=%00%2f..%2fetc"); log(T, "GET", "/templates.json?ref=enc", r.status, r.ms);
  r = await req("GET", "/templates?ref=" + encodeURIComponent("<script>alert(1)</script>"));
  log(T, "GET", "/templates?ref=xss", r.status, r.ms, r.head.includes("<script>alert(1)</script>") ? "REFLECTED-UNESCAPED" : "not-reflected/raw");
  // accept-header fuzz
  r = await req("GET", "/templates", { headers: { accept: "application/json" } });
  log(T, "GET", "/templates accept=json", r.status, r.ms, r.ctype);
  r = await req("GET", "/templates.json", { headers: { accept: "text/html" } });
  log(T, "GET", "/templates.json accept=html", r.status, r.ms, r.ctype);
  r = await req("GET", "/TEMPLATES"); log(T, "GET", "/TEMPLATES", r.status, r.ms);
  r = await req("GET", "/templates/"); log(T, "GET", "/templates/", r.status, r.ms);
  r = await req("GET", "/templates.json.json"); log(T, "GET", "/templates.json.json", r.status, r.ms);

  // ---------- R2: POST /api/referral-invites/mint ----------
  const M = "mint", P = "/api/referral-invites/mint";
  const post = (body, headers = {}) => req("POST", P, {
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : J(body),
  });
  r = await post({ roomId: "abc" }); log(M, "POST", P, r.status, r.ms, "no-auth " + r.head.slice(0, 120));
  r = await req("POST", P, { headers: { authorization: "Bearer fuzz-token", "content-type": "application/json" }, body: "" });
  log(M, "POST", P + " empty-body", r.status, r.ms, r.head.slice(0, 120));
  r = await req("POST", P, { headers: { authorization: "Bearer fuzz-token", "content-type": "application/json" }, body: "{not json" });
  log(M, "POST", P + " malformed-json", r.status, r.ms, r.head.slice(0, 120));
  const B = "Bearer fuzz-token";
  for (const [nm, b] of [
    ["ok-min", { roomId: "room_x" }],
    ["ok-cap", { roomId: "room_x", maxDepth: 3 }],
    ["missing-roomId", {}],
    ["roomId-num", { roomId: 123 }],
    ["roomId-null", { roomId: null }],
    ["extra-key", { roomId: "x", bogus: 1 }],
    ["maxDepth-str", { roomId: "x", maxDepth: "deep" }],
    ["maxDepth-neg", { roomId: "x", maxDepth: -5 }],
    ["maxDepth-float", { roomId: "x", maxDepth: 1.5 }],
    ["maxDepth-huge", { roomId: "x", maxDepth: 1e308 }],
    ["maxDepth-inf-str", { roomId: "x", maxDepth: Infinity }],
    ["roomId-empty", { roomId: "" }],
    ["roomId-5k", { roomId: "r".repeat(5000) }],
    ["roomId-traversal", { roomId: "../../etc/passwd" }],
    ["roomId-unicode", { roomId: "röö🤖m" }],
    ["arr-body", [1, 2]],
    ["null-body", null],
    ["str-body", "hello"],
    ["num-body", 42],
  ]) {
    r = await post(b, { authorization: B }); log(M, "POST", P + " " + nm, r.status, r.ms, r.head.slice(0, 150));
  }
  // wrong content type
  r = await req("POST", P, { headers: { authorization: B, "content-type": "text/plain" }, body: J({ roomId: "x" }) });
  log(M, "POST", P + " text/plain", r.status, r.ms, r.head.slice(0, 120));
  // wrong methods
  for (const m of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    r = await req(m, P, { headers: { authorization: B } }); log(M, m, P, r.status, r.ms, "allow=" + r.allow);
  }
  // huge body (1MB)
  r = await req("POST", P, { headers: { authorization: B, "content-type": "application/json" }, body: J({ roomId: "x".repeat(1024 * 1024) }) });
  log(M, "POST", P + " 1MB-body", r.status, r.ms, r.head.slice(0, 120));

  mkdirSync(new URL(".", import.meta.url).pathname, { recursive: true });
  writeFileSync(new URL("./fuzz-31-results.json", import.meta.url), JSON.stringify(OUT, null, 1));
  for (const o of OUT) console.log(`${o.name} ${o.method} ${o.path} -> ${o.status} (${o.ms}ms) ${o.extra}`);
  const bad = OUT.filter((o) => o.status === 500 || String(o.status).startsWith("ERR") || o.status === "TIMEOUT" || o.extra.includes("REFLECTED-UNESCAPED"));
  console.log("ANOMALIES:", bad.length);
}
main();
