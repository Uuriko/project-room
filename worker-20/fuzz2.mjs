// Round 2 edge fuzz — worker-20 shard.
const BASE = "http://127.0.0.1:4550";
const ORIGIN = BASE;
const results = [];
async function req(method, path, { headers = {}, rawBody = undefined, body = undefined } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  const s = Date.now();
  try {
    const r = await fetch(BASE + path, { method, headers, body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const tx = await r.text();
    return { status: r.status, ms: Date.now() - s, body: tx.slice(0, 200) };
  } catch (e) { return { status: "ERROR", ms: Date.now() - s, body: String(e).slice(0, 200) }; }
  finally { clearTimeout(t); }
}
async function case_(name, method, path, opts, expect) {
  const r = await req(method, path, opts);
  const pass = expect(r);
  results.push({ name, status: r.status, ms: r.ms, pass, sample: r.body.slice(0, 100) });
}
const OH = { Origin: ORIGIN, "Content-Type": "application/json" };
const P = "/api/guest-agent-links/preview";

await case_("A16 20k path suffix -> not 5xx, fast", "GET", "/api/oauth/sessions/" + "x".repeat(20000), {}, r => r.status !== 500 && r.status !== "ERROR" && r.ms < 5000);
await case_("A17 128-char session id DELETE (no cookie) -> 401 not 5xx", "DELETE", "/api/oauth/sessions/" + "y".repeat(128), {}, r => r.status !== 500 && r.status !== "ERROR");
await case_("A18 DELETE 200-char id -> not 5xx", "DELETE", "/api/oauth/sessions/" + "z".repeat(200), {}, r => r.status !== 500 && r.status !== "ERROR");
await case_("A19 DELETE id with dots/enc slash -> not 5xx", "DELETE", "/api/oauth/sessions/a..b%2fc", {}, r => r.status !== 500 && r.status !== "ERROR");
await case_("B28 dup JSON keys -> not 5xx", "POST", P, { headers: OH, rawBody: '{"linkToken":"a","linkToken":"b"}' }, r => r.status !== 500 && r.status !== "ERROR");
await case_("B29 ga1. prefix only -> 410", "POST", P, { headers: OH, body: { linkToken: "ga1." } }, r => r.status === 410);
await case_("B30 token w/ invalid chars -> 410", "POST", P, { headers: OH, body: { linkToken: "ga1." + "!".repeat(43) } }, r => r.status === 410);
await case_("B31 charset content-type accepted -> 410 (not 415)", "POST", P, { headers: { Origin: ORIGIN, "Content-Type": "application/json; charset=utf-8" }, body: { linkToken: "nope" } }, r => r.status === 410);
await case_("B32 nested object body -> 422", "POST", P, { headers: OH, body: { linkToken: "x", nested: { a: [1, { b: 2 }] } } }, r => r.status === 422);
await case_("B33 proto-pollution keys -> 422", "POST", P, { headers: OH, rawBody: '{"linkToken":"x","__proto__":{"a":1}}' }, r => r.status === 422);
await case_("B34 trailing garbage after JSON -> 400", "POST", P, { headers: OH, rawBody: '{"linkToken":"x"} trailing' }, r => r.status === 400);
await case_("B35 double-encoded token -> 410", "POST", P, { headers: OH, body: { linkToken: "%2561%31." } }, r => r.status === 410);
await case_("Z2 health after round2 -> 200", "GET", "/api/health", {}, r => r.status === 200);

const fails = results.filter(r => !r.pass);
console.log(JSON.stringify({ total: results.length, fails }, null, 1));
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./fuzz2-results.json", import.meta.url), JSON.stringify(results, null, 1));
