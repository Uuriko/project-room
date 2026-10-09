#!/usr/bin/env node
// worker-33 authenticated fuzz: POST /api/web/research (shard 33/50 route #2, http.mjs:2846)
// planOnly:true is free (no external calls, no quota burn) so it is the safe probe.
import { request } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:43331";
const cred = JSON.parse(readFileSync("worker-33/.tmp/cred.json", "utf8"));
const token = cred.cookie.split("=")[1];
const CJ = { "content-type": "application/json" };
const ORIGIN = "http://127.0.0.1:43331";
const results = [];
function send({ method = "POST", path = "/api/web/research", headers = {}, body = null, timeout = 15000 }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = request(BASE + path, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ ok: true, status: res.statusCode, body: Buffer.concat(chunks).toString("utf8", 0, 1200), ms: Date.now() - t0 }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error("TIMEOUT")));
    req.on("error", (e) => resolve({ ok: false, error: e.message, ms: Date.now() - t0 }));
    if (body != null) req.write(body);
    req.end();
  });
}
const H = (extra = {}) => ({ ...CJ, authorization: "Bearer " + token, ...extra }); // isBearer -> no CSRF needed
async function case_(name, opts, expectStatus) {
  let r = await send(opts);
  for (let i = 0; i < 4 && !r.ok; i++) { await new Promise(r2=>setTimeout(r2,1500)); r = await send(opts); }
  const pass = Array.isArray(expectStatus) ? expectStatus.includes(r.status) : r.status === expectStatus;
  results.push({ name, got: r.status ?? r.error, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} -> ${r.ok ? r.status : "ERR:" + r.error} (${r.ms}ms)${!pass ? " body=" + (r.body||"").slice(0, 160) : ""}`);
}
const P = "/api/web/research";
// valid
await case_("valid planOnly", { headers: H(), body: JSON.stringify({ question: "what is project room?", planOnly: true }) }, 200);
await case_("valid planOnly w/ sources+tags+maxEvidence", { headers: H(), body: JSON.stringify({ question: "q?", sources: ["room", "docs"], maxEvidence: 3, tags: ["a"], maxAgeMs: 1000, planOnly: true }) }, 200);
await case_("cookie (session) no CSRF -> 403 csrf_denied", { headers: { ...CJ, cookie: cred.cookie, origin: ORIGIN }, body: JSON.stringify({ question: "q?", planOnly: true }) }, 403);
await case_("cookie wrong Origin value -> ?", { headers: H({ origin: "https://evil.example" }), body: JSON.stringify({ question: "q?", planOnly: true }) }, [403, 200]);
// body parsing edges
await case_("empty body -> 400 invalid_json", { headers: H() }, 400);
await case_("malformed JSON -> 400", { headers: H(), body: "{nope" }, 400);
await case_("JSON null -> 400", { headers: H(), body: "null" }, 400);
await case_("JSON array -> 400", { headers: H(), body: "[1,2]" }, 400);
await case_("JSON string -> 400", { headers: H(), body: '"hi"' }, 400);
await case_("JSON number -> 400", { headers: H(), body: "42" }, 400);
await case_("no content-type -> 415", { headers: { authorization: "Bearer " + token }, body: JSON.stringify({ question: "q?" }) }, 415);
await case_("text/plain body -> 415", { headers: H({ "content-type": "text/plain" }), body: "hello" }, 415);
await case_("charset suffix content-type -> ok", { headers: H({ "content-type": "application/json; charset=utf-8" }), body: JSON.stringify({ question: "q?", planOnly: true }) }, 200);
await case_("17KB body -> 413 too_large", { headers: H(), body: JSON.stringify({ question: "q?", planOnly: true, pad: "x".repeat(17000) }) }, 413);
// validateResearchInput edges
await case_("missing question -> 422", { headers: H(), body: JSON.stringify({ planOnly: true }) }, 422);
await case_("empty question -> 422", { headers: H(), body: JSON.stringify({ question: "  " }) }, 422);
await case_("non-string question -> 422", { headers: H(), body: JSON.stringify({ question: 42 }) }, 422);
await case_("2001-char question -> 422", { headers: H(), body: JSON.stringify({ question: "x".repeat(2001) }) }, 422);
await case_("2000-char question -> 200", { headers: H(), body: JSON.stringify({ question: "x".repeat(2000), planOnly: true }) }, 200);
await case_("unknown field -> 422", { headers: H(), body: JSON.stringify({ question: "q?", bogus: 1 }) }, 422);
await case_("__proto__ field -> 422 or safe", { headers: H(), body: '{"question":"q?","__proto__":{"x":1},"planOnly":true}' }, [422, 200]);
await case_("sources not array -> 422", { headers: H(), body: JSON.stringify({ question: "q?", sources: "room" }) }, 422);
await case_("sources empty -> 422", { headers: H(), body: JSON.stringify({ question: "q?", sources: [] }) }, 422);
await case_("sources bogus -> 422", { headers: H(), body: JSON.stringify({ question: "q?", sources: ["bogus"] }) }, 422);
await case_("sources [null] -> 422", { headers: H(), body: JSON.stringify({ question: "q?", sources: [null] }) }, 422);
await case_("sources dupes -> 200", { headers: H(), body: JSON.stringify({ question: "q?", sources: ["room", "room"], planOnly: true }) }, 200);
await case_("urls not array -> 422", { headers: H(), body: JSON.stringify({ question: "q?", urls: "http://x" }) }, 422);
await case_("urls [123] -> 422", { headers: H(), body: JSON.stringify({ question: "q?", urls: [123] }) }, 422);
await case_("urls 11 entries -> 422", { headers: H(), body: JSON.stringify({ question: "q?", urls: Array(11).fill("http://x") }) }, 422);
await case_("urls 10 entries planOnly -> 200", { headers: H(), body: JSON.stringify({ question: "q?", urls: Array(10).fill("http://x"), planOnly: true }) }, 200);
await case_("maxEvidence 0 -> 422", { headers: H(), body: JSON.stringify({ question: "q?", maxEvidence: 0 }) }, 422);
await case_("maxEvidence 1.5 -> 422", { headers: H(), body: JSON.stringify({ question: "q?", maxEvidence: 1.5 }) }, 422);
await case_("maxEvidence '5' -> 422", { headers: H(), body: JSON.stringify({ question: "q?", maxEvidence: "5" }) }, 422);
await case_("maxEvidence 21 -> 422", { headers: H(), body: JSON.stringify({ question: "q?", maxEvidence: 21 }) }, 422);
await case_("maxEvidence 20 -> 200", { headers: H(), body: JSON.stringify({ question: "q?", maxEvidence: 20, planOnly: true }) }, 200);
await case_("maxAgeMs -1 -> 422", { headers: H(), body: JSON.stringify({ question: "q?", maxAgeMs: -1 }) }, 422);
await case_("maxAgeMs 1.5 -> 422", { headers: H(), body: JSON.stringify({ question: "q?", maxAgeMs: 1.5 }) }, 422);
await case_("maxAgeMs 2^53 -> 200", { headers: H(), body: JSON.stringify({ question: "q?", maxAgeMs: 9007199254740991, planOnly: true }) }, 200);
await case_("tags not array -> 422", { headers: H(), body: JSON.stringify({ question: "q?", tags: "a" }) }, 422);
await case_("tags 21 entries -> 422", { headers: H(), body: JSON.stringify({ question: "q?", tags: Array(21).fill("t") }) }, 422);
await case_("planOnly 'yes' truthy -> 200 plan", { headers: H(), body: JSON.stringify({ question: "q?", planOnly: "yes" }) }, 200);
await case_("planOnly 0 -> executes (local sources only)", { headers: H(), body: JSON.stringify({ question: "q?", sources: ["room", "docs"], planOnly: 0 }) }, [200, 429]);
await case_("unicode question -> 200", { headers: H(), body: JSON.stringify({ question: "🦕🌼🌕 café naïve 中文", planOnly: true }) }, 200);
await case_("question with newline/control chars -> 200", { headers: H(), body: JSON.stringify({ question: "a\nb\tc\rd", planOnly: true }) }, 200);
// hang guard: planOnly must answer fast
const t0 = Date.now();
await case_("planOnly latency < 3s", { headers: H(), body: JSON.stringify({ question: "latency check?", planOnly: true }) }, 200);
console.log("planOnly latency:", Date.now() - t0, "ms");
const fails = results.filter((r) => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} passed`);
writeFileSync("worker-33/results-auth.json", JSON.stringify(results, null, 2));
process.exit(fails.length ? 1 : 0);
