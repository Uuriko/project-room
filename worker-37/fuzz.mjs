// WAVE-2000 GUILD-02 WORKER-37 fuzz: shard = route handlers at sorted indices 36, 86
// index 36 -> server/http.mjs:1929  GET/HEAD /favicon.ico , /room/favicon.ico -> 301
// index 86 -> server/http.mjs:2880  POST /api/claims/validate
import http from "node:http";
import { writeFileSync } from "node:fs";

const HOST = "127.0.0.1", PORT = 4711;
const results = [];
const anomalies = [];

function req({ method = "GET", path = "/", headers = {}, body = null, raw = false, timeout = 6000 }) {
  return new Promise(resolve => {
    const started = Date.now();
    const o = http.request({ host: HOST, port: PORT, method, path, headers, timeout }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8").slice(0, 400),
        ms: Date.now() - started,
      }));
    });
    o.on("timeout", () => { o.destroy(new Error("client-timeout")); });
    o.on("error", e => resolve({ status: "ERR:" + e.message, headers: {}, body: "", ms: Date.now() - started }));
    if (body !== null) o.write(body);
    o.end();
  });
}

async function t(name, opts, expect) {
  const r = await req(opts);
  const slow = r.ms > 3000;
  const bad = typeof r.status === "string" || r.status >= 500 || slow
    || (expect && !expect(r));
  results.push({ name, ...optsSummary(opts), status: r.status, ms: r.ms, loc: r.headers.location ?? null, body: r.body, expect: expect ? "custom" : "none" });
  if (bad) anomalies.push({ name, status: r.status, ms: r.ms, body: r.body, opts: optsSummary(opts) });
  console.log(`${bad ? "!!!" : "ok "} [${r.status}] ${r.ms}ms ${name}`);
  return r;
}
function optsSummary(o) { return { method: o.method, path: String(o.path).slice(0, 120) }; }

const J = { "content-type": "application/json" };
const validClaim = "```room-claim\ntask-id: RC-2026-10-09-001\nlane: fuzz\nfiles: server/http.mjs\nlease: lease=2h\nstate: working\nreason: fuzzing\n```\n";
const MAX = 65536, LIMIT = MAX + 8192; // 73728

// ---------- Handler A: favicon redirects (line 1929) ----------
await t("A01 GET /favicon.ico -> 301 /favicon.svg", { path: "/favicon.ico" },
  r => r.status === 301 && r.headers.location === "/favicon.svg");
await t("A02 GET /room/favicon.ico -> 301 /room/favicon.svg", { path: "/room/favicon.ico" },
  r => r.status === 301 && r.headers.location === "/room/favicon.svg");
await t("A03 HEAD /favicon.ico -> 301 empty", { method: "HEAD", path: "/favicon.ico" },
  r => r.status === 301 && r.body === "");
await t("A04 POST /favicon.ico (fallthrough, observe)", { method: "POST", path: "/favicon.ico" });
await t("A05 PUT /favicon.ico (fallthrough, observe)", { method: "PUT", path: "/favicon.ico" });
await t("A06 DELETE /room/favicon.ico (fallthrough, observe)", { method: "DELETE", path: "/room/favicon.ico" });
await t("A07 OPTIONS /favicon.ico (observe)", { method: "OPTIONS", path: "/favicon.ico" });
await t("A08 GET /FAVICON.ICO (case, observe)", { path: "/FAVICON.ICO" });
await t("A09 GET /favicon.ico/ (trailing slash, observe)", { path: "/favicon.ico/" });
await t("A10 GET //favicon.ico (double slash, observe)", { path: "//favicon.ico" });
await t("A11 GET /favicon.ico?x=100k (query echo in Location)", { path: "/favicon.ico?x=" + "q".repeat(100000) },
  r => r.status === 301);
await t("A12 GET /%66avicon.ico (encoded f, observe)", { path: "/%66avicon.ico" });
await t("A13 GET /favicon.ico%00 (encoded null, observe)", { path: "/favicon.ico%00" });
await t("A14 GET /favicon.ico + 8000 chars (long path)", { path: "/favicon.ico" + "a".repeat(8000) });
await t("A15 GET /room/room/favicon.ico (nested, observe)", { path: "/room/room/favicon.ico" });
await t("A16 GET /ROOM/favicon.ico (case room, observe)", { path: "/ROOM/favicon.ico" });
await t("A17 GET /favicon.svg (redirect target itself)", { path: "/favicon.svg" });
await t("A18 GET /favicon.ico?x=%00%ff (weird query)", { path: "/favicon.ico?x=%00%ff" },
  r => r.status === 301);

// ---------- Handler B: POST /api/claims/validate (line 2880) ----------
// NOTE: rate bucket is 30/min per address; functional POSTs kept under budget, rate test last.
await t("B01 GET -> 405 Allow: POST", { method: "GET", path: "/api/claims/validate" },
  r => r.status === 405 && /POST/.test(r.headers.allow ?? ""));
await t("B02 PUT -> 405", { method: "PUT", path: "/api/claims/validate", headers: J, body: "{}" },
  r => r.status === 405);
await t("B03 DELETE -> 405", { method: "DELETE", path: "/api/claims/validate" },
  r => r.status === 405);
await t("B04 PATCH -> 405", { method: "PATCH", path: "/api/claims/validate", headers: J, body: "{}" },
  r => r.status === 405);
await t("B05 OPTIONS -> 405", { method: "OPTIONS", path: "/api/claims/validate" },
  r => r.status === 405);
await t("B06 HEAD -> 405", { method: "HEAD", path: "/api/claims/validate" },
  r => r.status === 405);
await t("B07 POST no content-type -> 415", { method: "POST", path: "/api/claims/validate", body: '{"text":"x"}' },
  r => r.status === 415);
await t("B08 POST text/plain -> 415", { method: "POST", path: "/api/claims/validate", headers: { "content-type": "text/plain" }, body: "x" },
  r => r.status === 415);
await t("B09 POST empty body + json ct -> 400 invalid_json", { method: "POST", path: "/api/claims/validate", headers: J, body: "" },
  r => r.status === 400);
await t("B10 POST {} -> 422 invalid_claim_text", { method: "POST", path: "/api/claims/validate", headers: J, body: "{}" },
  r => r.status === 422 && r.body.includes("invalid_claim_text"));
await t("B11 POST {text:123} -> 422", { method: "POST", path: "/api/claims/validate", headers: J, body: '{"text":123}' },
  r => r.status === 422);
await t("B12 POST {text:null} -> 422", { method: "POST", path: "/api/claims/validate", headers: J, body: '{"text":null}' },
  r => r.status === 422);
await t("B13 POST {text:'ok',extra:1} -> 422 (strict fields)", { method: "POST", path: "/api/claims/validate", headers: J, body: '{"text":"ok","extra":1}' },
  r => r.status === 422);
await t("B14 POST [] -> 400 invalid_json", { method: "POST", path: "/api/claims/validate", headers: J, body: "[]" },
  r => r.status === 400);
await t("B15 POST 'str' -> 400", { method: "POST", path: "/api/claims/validate", headers: J, body: '"str"' },
  r => r.status === 400);
await t("B16 POST null -> 400", { method: "POST", path: "/api/claims/validate", headers: J, body: "null" },
  r => r.status === 400);
await t("B17 POST malformed JSON -> 400", { method: "POST", path: "/api/claims/validate", headers: J, body: '{"text":' },
  r => r.status === 400);
await t("B18 POST valid claim -> 200 valid:true", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: validClaim }) },
  r => r.status === 200 && r.body.includes('"valid":true'));
await t("B19 POST claim missing fields -> 200 valid:false + errors", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: "```room-claim\ntask-id: RC-2026-10-09-002\n```\n" }) },
  r => r.status === 200 && r.body.includes('"valid":false') && r.body.includes("missing lane"));
await t("B20 POST no fence block -> 200 valid:false", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: "hello world" }) },
  r => r.status === 200 && r.body.includes("no room-claim fenced block found"));
await t("B21 POST text exactly MAX chars -> 200 (length ok)", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: "x".repeat(MAX) }) },
  r => r.status === 200);
await t("B22 POST text MAX+1 chars -> 422 text_too_long", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: "x".repeat(MAX + 1) }) },
  r => r.status === 422 && r.body.includes("text_too_long"));
await t("B23 POST body ~LIMIT-100 bytes -> 200", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: "y".repeat(LIMIT - 200) }) },
  r => r.status === 200);
await t("B24 POST body LIMIT+1000 bytes -> 413 too_large", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: "z".repeat(LIMIT + 1000) }) },
  r => r.status === 413 && r.body.includes("too_large"));
await t("B25 POST nested text {text:{a:1}} -> 422", { method: "POST", path: "/api/claims/validate", headers: J, body: '{"text":{"a":1}}' },
  r => r.status === 422);
await t("B26 POST charset param ct -> accepted", { method: "POST", path: "/api/claims/validate", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ text: validClaim }) },
  r => r.status === 200);
await t("B27 POST ct case-insensitive -> accepted", { method: "POST", path: "/api/claims/validate", headers: { "content-type": "Application/JSON" }, body: JSON.stringify({ text: validClaim }) },
  r => r.status === 200);
await t("B28 POST text with null byte -> 200 (observe)", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: "a b" }) });
await t("B29 POST text with unpaired surrogate -> (observe)", { method: "POST", path: "/api/claims/validate", headers: J, body: '{"text":"\\ud800"}' });
await t("B30 POST text with astral chars -> (observe)", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: "🦕".repeat(1000) }) });
await t("B31 POST 100 nested fences -> (observe perf)", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: "```room-claim\n" + "k: v\n".repeat(2000) + "```\n" }) });
await t("B32 POST bare failed state -> 'failed requires a failure code'", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: validClaim.replace("state: working", "state: failed") }) },
  r => r.status === 200 && r.body.includes("failed requires a failure code"));
await t("B33 POST failed(code) state -> valid", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: validClaim.replace("state: working", "state: failed(OOM)") }) },
  r => r.status === 200 && r.body.includes('"valid":true'));
await t("B34 POST lease=0h -> out of range", { method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: validClaim.replace("lease=2h", "lease=0h") }) },
  r => r.status === 200 && r.body.includes("lease out of range"));
await t("B35 POST chunked body -> (observe)", { method: "POST", path: "/api/claims/validate", headers: { ...J, "transfer-encoding": "chunked" }, body: JSON.stringify({ text: validClaim }) },
  r => r.status === 200);

// ---------- rate limit LAST (consumes bucket) ----------
let saw429 = false;
for (let i = 0; i < 35; i++) {
  const r = await req({ method: "POST", path: "/api/claims/validate", headers: J, body: JSON.stringify({ text: validClaim }) });
  if (r.status === 429) { saw429 = true; console.log(`ok  [429] rate limit hit at burst #${i + 1}`); break; }
}
results.push({ name: "B36 rate-limit burst: 429 observed", status: saw429 ? 429 : "no-429" });
if (!saw429) anomalies.push({ name: "B36 rate limit never triggered in 35-request burst", status: "MISSING-429" });

writeFileSync("worker-37/results.json", JSON.stringify({ results, anomalies }, null, 2));
console.log(`\nDONE: ${results.length} cases, ${anomalies.length} anomalies`);
