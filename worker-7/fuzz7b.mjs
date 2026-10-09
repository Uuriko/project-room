#!/usr/bin/env node
// WAVE-2000 G02 worker-7 fuzz round 2: corrected content-type on rawBody cases
const BASE = "http://127.0.0.1:45971";
const ORIGIN = "http://127.0.0.1:45971";
const results = [];
async function req(method, path, { headers = {}, body = null, rawBody = null, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const init = { method, headers: { ...headers }, signal: ctrl.signal };
  if (rawBody !== null) { init.body = rawBody; init.headers["content-type"] = init.headers["content-type"] || "application/json"; }
  else if (body !== null) { init.body = JSON.stringify(body); init.headers["content-type"] = init.headers["content-type"] || "application/json"; }
  const start = Date.now();
  try {
    const r = await fetch(BASE + path, init);
    const text = await r.text();
    clearTimeout(t);
    return { status: r.status, ms: Date.now() - start, body: text.slice(0, 300) };
  } catch (e) {
    clearTimeout(t);
    return { status: "ERROR", ms: Date.now() - start, body: String(e).slice(0, 200) };
  }
}
async function t(name, method, path, opts, expect) {
  const r = await req(method, path, opts);
  const ok = Array.isArray(expect) ? expect.includes(r.status) : r.status === expect;
  results.push({ name, expect, got: r.status, ms: r.ms, ok, body: r.body });
  console.log(`${ok ? "PASS" : "FAIL"} [${r.status} expect ${expect}] ${r.ms}ms ${name}${!ok ? " :: " + r.body.slice(0,120) : ""}`);
}
const P = "/api/guest-agent-links/preview";
const O = { origin: ORIGIN };
await t("empty body", "POST", P, { headers: O, rawBody: "" }, 400);
await t("malformed json", "POST", P, { headers: O, rawBody: '{"linkToken":' }, 400);
await t("array body", "POST", P, { headers: O, rawBody: '[]' }, 400);
await t("null body", "POST", P, { headers: O, rawBody: 'null' }, 400);
await t("string body", "POST", P, { headers: O, rawBody: '"hi"' }, 400);
await t("number body", "POST", P, { headers: O, rawBody: '42' }, 400);
await t("dup keys", "POST", P, { headers: O, rawBody: '{"linkToken":"a","linkToken":"b"}' }, 410);
await t("oversized", "POST", P, { headers: O, rawBody: JSON.stringify({ linkToken: "x".repeat(20000) }) }, 413);
// well-known discovery contract spot-checks
await t("wellknown fields", "GET", "/.well-known/oauth-authorization-server", {}, 200);
const r2 = await req("GET", "/.well-known/oauth-authorization-server", {});
try {
  const j = JSON.parse(r2.body);
  const need = ["issuer","authorization_endpoint","token_endpoint","revocation_endpoint","response_types_supported","grant_types_supported","code_challenge_methods_supported","scopes_supported","token_endpoint_auth_methods_supported"];
  const missing = need.filter(k => !(k in j));
  console.log(missing.length ? "FAIL missing fields: " + missing.join(",") : "PASS wellknown RFC8414 field set complete");
  results.push({ name: "wellknown RFC8414 field set", ok: !missing.length, missing });
  console.log(`content-type: check`); 
} catch { console.log("FAIL wellknown body not JSON"); }
const fails = results.filter(r => !r.ok || r.status >= 500 || r.status === "ERROR");
console.log(`\n${results.length} checks, ${fails.length} failures/anomalies`);
import { writeFileSync } from "node:fs";
writeFileSync("/home/hatch/workspace/pr-wave2000-guild-02/worker-7/fuzz-results-2.json", JSON.stringify(results, null, 2));
