// WAVE-2000 guild-02 worker-20 fuzz harness.
// Shard 19/50: GET /api/oauth/sessions (http.mjs:1598), POST /api/guest-agent-links/preview (http.mjs:2434).
const BASE = "http://127.0.0.1:4550";
const ORIGIN = BASE;
const results = [];
const TIMEOUT_MS = 8000;

async function req(method, path, { headers = {}, body = undefined, rawBody = undefined, timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { ...headers },
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - started, body: text.slice(0, 400) };
  } catch (e) {
    return { status: "ERROR", ms: Date.now() - started, body: `${e.name}: ${e.message}`.slice(0, 400) };
  } finally {
    clearTimeout(t);
  }
}

async function case_(name, method, path, opts, expect) {
  const r = await req(method, path, opts);
  const code = (() => { try { return JSON.parse(r.body)?.code ?? null; } catch { return null; } })();
  const pass = expect(r);
  results.push({ name, method, path, status: r.status, ms: r.ms, code, pass, sample: r.body.slice(0, 120) });
}

// ---- Handler A: GET /api/oauth/sessions ----
await case_("A1 no cookie -> 401", "GET", "/api/oauth/sessions", {}, r => r.status === 401);
await case_("A2 empty cookie -> 401", "GET", "/api/oauth/sessions", { headers: { Cookie: "prs_account=" } }, r => r.status === 401);
await case_("A3 garbage cookie -> 401", "GET", "/api/oauth/sessions", { headers: { Cookie: "prs_account=garbage-token" } }, r => r.status === 401);
await case_("A4 long cookie (10KB) -> 401, no hang", "GET", "/api/oauth/sessions", { headers: { Cookie: "prs_account=" + "x".repeat(10240) } }, r => r.status === 401 && r.ms < 3000);
await case_("A5 sqli cookie -> 401", "GET", "/api/oauth/sessions", { headers: { Cookie: `prs_account=' OR '1'='1` } }, r => r.status === 401);
await case_("A6 unicode cookie -> 401", "GET", "/api/oauth/sessions", { headers: { Cookie: "prs_account=" + encodeURIComponent("☃️💣") } }, r => r.status === 401);
await case_("A7 query string -> 401 (no crash)", "GET", "/api/oauth/sessions?foo=bar&limit=9999", {}, r => r.status === 401);
await case_("A8 trailing slash -> not 5xx", "GET", "/api/oauth/sessions/", {}, r => r.status !== 500 && r.status !== "ERROR");
await case_("A9 uppercase path -> not 5xx", "GET", "/api/OAUTH/SESSIONS", {}, r => r.status !== 500 && r.status !== "ERROR");
await case_("A10 POST -> not 5xx", "POST", "/api/oauth/sessions", { headers: { "Content-Type": "application/json" }, body: {} }, r => r.status !== 500 && r.status !== "ERROR");
await case_("A11 PUT -> not 5xx", "PUT", "/api/oauth/sessions", { headers: { "Content-Type": "application/json" }, body: {} }, r => r.status !== 500 && r.status !== "ERROR");
await case_("A12 DELETE -> not 5xx", "DELETE", "/api/oauth/sessions", {}, r => r.status !== 500 && r.status !== "ERROR");
await case_("A13 PATCH -> not 5xx", "PATCH", "/api/oauth/sessions", { headers: { "Content-Type": "application/json" }, body: {} }, r => r.status !== 500 && r.status !== "ERROR");
await case_("A14 HEAD -> not 5xx", "HEAD", "/api/oauth/sessions", {}, r => r.status !== 500 && r.status !== "ERROR");
await case_("A15 OPTIONS -> not 5xx", "OPTIONS", "/api/oauth/sessions", {}, r => r.status !== 500 && r.status !== "ERROR");

// ---- Handler B: POST /api/guest-agent-links/preview ----
const P = "/api/guest-agent-links/preview";
const withOrigin = { headers: { Origin: ORIGIN, "Content-Type": "application/json" } };
await case_("B1 no origin -> 403 origin_denied", "POST", P, { headers: { "Content-Type": "application/json" }, body: { linkToken: "x" } }, r => r.status === 403);
await case_("B2 evil origin -> 403", "POST", P, { headers: { Origin: "http://evil.com", "Content-Type": "application/json" }, body: { linkToken: "x" } }, r => r.status === 403);
await case_("B3 origin null -> 403", "POST", P, { headers: { Origin: "null", "Content-Type": "application/json" }, body: { linkToken: "x" } }, r => r.status === 403);
await case_("B4 origin trailing slash -> 403", "POST", P, { headers: { Origin: ORIGIN + "/", "Content-Type": "application/json" }, body: { linkToken: "x" } }, r => r.status === 403);
await case_("B5 wrong content-type -> 415", "POST", P, { headers: { Origin: ORIGIN, "Content-Type": "text/plain" }, rawBody: "{}" }, r => r.status === 415);
await case_("B6 no content-type -> 415", "POST", P, { headers: { Origin: ORIGIN } }, r => r.status === 415);
await case_("B7 invalid JSON -> 400", "POST", P, { headers: { Origin: ORIGIN, "Content-Type": "application/json" }, rawBody: "{not json" }, r => r.status === 400);
await case_("B8 empty body -> 400", "POST", P, { headers: { Origin: ORIGIN, "Content-Type": "application/json" }, rawBody: "" }, r => r.status === 400);
await case_("B9 JSON array -> 400", "POST", P, { headers: { Origin: ORIGIN, "Content-Type": "application/json" }, rawBody: "[1,2]" }, r => r.status === 400);
await case_("B10 JSON null -> 400", "POST", P, { headers: { Origin: ORIGIN, "Content-Type": "application/json" }, rawBody: "null" }, r => r.status === 400);
await case_("B11 JSON string -> 400", "POST", P, { headers: { Origin: ORIGIN, "Content-Type": "application/json" }, rawBody: "\"str\"" }, r => r.status === 400);
await case_("B12 missing linkToken -> 422", "POST", P, { ...withOrigin, body: {} }, r => r.status === 422);
await case_("B13 extra keys -> 422", "POST", P, { ...withOrigin, body: { linkToken: "x", foo: 1 } }, r => r.status === 422);
await case_("B14 null linkToken -> 410 (type-safe)", "POST", P, { ...withOrigin, body: { linkToken: null } }, r => r.status === 410);
await case_("B15 number linkToken -> 410 (type-safe)", "POST", P, { ...withOrigin, body: { linkToken: 123 } }, r => r.status === 410);
await case_("B16 bool linkToken -> 410 (type-safe)", "POST", P, { ...withOrigin, body: { linkToken: true } }, r => r.status === 410);
await case_("B17 array linkToken -> 410 (type-safe)", "POST", P, { ...withOrigin, body: { linkToken: [] } }, r => r.status === 410);
await case_("B18 object linkToken -> 410 (type-safe)", "POST", P, { ...withOrigin, body: { linkToken: { t: "x" } } }, r => r.status === 410);
await case_("B19 empty string token -> 410", "POST", P, { ...withOrigin, body: { linkToken: "" } }, r => r.status === 410);
await case_("B20 garbage token -> 410", "POST", P, { ...withOrigin, body: { linkToken: "definitely-not-a-token" } }, r => r.status === 410);
await case_("B21 well-formed unknown ga1 token -> 410", "POST", P, { ...withOrigin, body: { linkToken: "ga1." + "A".repeat(43) } }, r => r.status === 410);
await case_("B22 human-share-shaped token -> 422 wrong_link_kind", "POST", P, { ...withOrigin, body: { linkToken: "B".repeat(43) } }, r => r.status === 422);
await case_("B23 huge token (100KB) -> no hang, not 5xx", "POST", P, { ...withOrigin, body: { linkToken: "ga1." + "C".repeat(100000) } }, r => r.status !== 500 && r.status !== "ERROR" && r.ms < 5000);
await case_("B24 unicode token -> not 5xx", "POST", P, { ...withOrigin, body: { linkToken: "ga1.☃️" } }, r => r.status !== 500 && r.status !== "ERROR");
await case_("B25 oversized body (20KB) -> 413", "POST", P, { headers: { Origin: ORIGIN, "Content-Type": "application/json" }, rawBody: JSON.stringify({ linkToken: "x".repeat(20000) }) }, r => r.status === 413);
await case_("B26 GET method -> not 5xx", "GET", P, { headers: { Origin: ORIGIN } }, r => r.status !== 500 && r.status !== "ERROR");
await case_("B27 DELETE method -> not 5xx", "DELETE", P, { headers: { Origin: ORIGIN } }, r => r.status !== 500 && r.status !== "ERROR");

// ---- server still alive ----
await case_("Z1 health after fuzz -> 200", "GET", "/api/health", {}, r => r.status === 200);

const fails = results.filter(r => !r.pass);
console.log(JSON.stringify({ total: results.length, fails: fails.length, fails }, null, 1));
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./fuzz-results.json", import.meta.url), JSON.stringify(results, null, 1));
