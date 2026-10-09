// WAVE-2000 Guild-02 Worker 5 — API fuzz battery for shard routes:
//   http.mjs:1214  POST /api/auth/email/verify/resend
//   http.mjs:2474  POST /api/guest-invites/preview
// Local-only against 127.0.0.1:4195. Uses node:http (fetch forbids Origin/Cookie
// headers). Records expected vs actual status, crash, hang (>8s), wrong-status.
import http from "node:http";
import { readFileSync } from "node:fs";

const HOST = "127.0.0.1", PORT = 4195;
const ORIGIN = "http://127.0.0.1:4195";
const seeds = JSON.parse(readFileSync("worker-5/seeds.json", "utf8"));

const results = [];
// Fresh connection per request: the server's 413 drain half-closes the socket,
// which races keep-alive reuse (client-visible "socket hang up", server healthy).
// That race is documented separately; the battery measures pure server behavior.
const noKA = new http.Agent({ keepAlive: false });

function req(name, opts) {
  return new Promise((resolve) => {
    const { method = "POST", path, expect, headers = {}, body, timeoutMs = 8000, note = "", noOrigin = false } = opts;
    const h = { ...headers };
    if (!noOrigin && h.Origin === undefined && h.origin === undefined) h.Origin = ORIGIN;
    const t0 = Date.now();
    const done = (status, code, verdict, err) =>
      { results.push({ name, method, path, expect, status, code, ms: Date.now() - t0, verdict, err, note }); resolve(); };
    const r = http.request({ host: HOST, port: PORT, method, path, headers: h, agent: noKA, timeout: timeoutMs }, (res) => {
      let raw = "";
      res.on("data", c => { raw += c; });
      res.on("end", () => {
        let code = null;
        try { code = JSON.parse(raw)?.error?.code ?? JSON.parse(raw)?.status ?? null; } catch { /* non-json */ }
        done(res.statusCode, code, res.statusCode === expect ? "ok" : "WRONG-STATUS", null);
      });
    });
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    r.on("error", (e) => done(null, null, e.message === "timeout" ? "HANG" : "TRANSPORT-ERR", e.message.slice(0, 120)));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const J = { "Content-Type": "application/json" };
const J2 = (b, extraHeaders = {}) => ({ headers: { ...J, ...extraHeaders }, body: b });
const validCode = "GX-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // matches /^GX-[A-Za-z0-9_-]{32}$/
const ck = t => ({ Cookie: `account_session=${t}` });
const P = "/api/guest-invites/preview";
const R = "/api/auth/email/verify/resend";

// ---------- ROUTE: POST /api/guest-invites/preview (no auth) ----------
await req("preview: GET -> 404 (method fallthrough)", { method: "GET", path: P, expect: 404 });
await req("preview: no Origin -> 403", { path: P, expect: 403, noOrigin: true, ...J2("{}") });
await req("preview: wrong Origin -> 403", { path: P, expect: 403, ...J2("{}", { Origin: "https://evil.example" }) });
await req("preview: missing content-type -> 415", { path: P, expect: 415, body: "{}" });
await req("preview: text/plain -> 415", { path: P, expect: 415, headers: { "Content-Type": "text/plain" }, body: "{}" });
await req("preview: empty body -> 400", { path: P, expect: 400, ...J2("") });
await req("preview: malformed JSON -> 400", { path: P, expect: 400, ...J2("{bad") });
await req("preview: JSON array -> 400", { path: P, expect: 400, ...J2("[1,2]") });
await req("preview: JSON number -> 400", { path: P, expect: 400, ...J2("42") });
await req("preview: JSON null -> 400", { path: P, expect: 400, ...J2("null") });
await req("preview: JSON string scalar -> 400", { path: P, expect: 400, ...J2('"hi"') });
await req("preview: {} -> 422", { path: P, expect: 422, ...J2("{}") });
await req("preview: extra field -> 422", { path: P, expect: 422, ...J2(JSON.stringify({ inviteCode: validCode, extra: 1 })) });
await req("preview: inviteCode number -> 422", { path: P, expect: 422, ...J2('{"inviteCode":123}') });
await req("preview: inviteCode null -> 422", { path: P, expect: 422, ...J2('{"inviteCode":null}') });
await req("preview: inviteCode bool -> 422", { path: P, expect: 422, ...J2('{"inviteCode":true}') });
await req("preview: inviteCode array -> 422", { path: P, expect: 422, ...J2('{"inviteCode":[]}') });
await req("preview: inviteCode object -> 422", { path: P, expect: 422, ...J2('{"inviteCode":{}}') });
await req("preview: short code -> 410", { path: P, expect: 410, ...J2('{"inviteCode":"GX-short"}') });
await req("preview: valid-format nonexistent -> 410", { path: P, expect: 410, ...J2(JSON.stringify({ inviteCode: validCode })) });
await req("preview: 15KB code -> 410", { path: P, expect: 410, ...J2(JSON.stringify({ inviteCode: "GX-" + "A".repeat(15000) })), note: "body still < 16KB cap" });
await req("preview: unicode code -> 410", { path: P, expect: 410, ...J2(JSON.stringify({ inviteCode: "GX-" + "À".repeat(32) })) });
await req("preview: lone-surrogate escape -> 410", { path: P, expect: 410, headers: J, body: '{"inviteCode":"GX-\\ud800AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}', note: "valid JSON; pattern fails" });
await req("preview: NUL byte in code -> 410", { path: P, expect: 410, ...J2(JSON.stringify({ inviteCode: "GX-AA\u0000" + "A".repeat(28) })) });
await req("preview: empty-string code -> 410", { path: P, expect: 410, ...J2('{"inviteCode":""}') });
{ // deep nesting that stays UNDER the 16KB body cap: 2000 levels ~ 12KB
  let deep = '{"inviteCode":"x"}';
  for (let i = 0; i < 2000; i++) deep = '{"w":' + deep + '}';
  await req("preview: deep nesting 2000 (12KB) -> 422", { path: P, expect: 422, ...J2(deep), note: "JSON.parse depth stress; parses fine at 2000, 422 on shape" });
await req("preview: body 16417 bytes -> 413", { path: P, expect: 413, ...J2(JSON.stringify({ inviteCode: "x".repeat(16400) })), note: "over the 16384 cap" });
}
await req("preview: charset content-type -> 410", { path: P, expect: 410, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ inviteCode: validCode }) });
await req("preview: trailing slash normalizes -> 422", { method: "POST", path: P + "/", expect: 422, ...J2("{}"), note: "line 952 strips trailing slash (by design)" });
await req("preview: wrong-case path -> 404", { method: "POST", path: "/API/guest-invites/preview", expect: 404, ...J2("{}") });
await req("preview: query string ignored -> 410", { path: P + "?x=1", expect: 410, ...J2(JSON.stringify({ inviteCode: validCode })) });
await req("preview: duplicate inviteCode keys -> 410", { path: P, expect: 410, headers: J, body: `{"inviteCode":"${validCode}","inviteCode":"${validCode}"}` });

// ---------- ROUTE: POST /api/auth/email/verify/resend ----------
await req("resend: GET -> 405", { method: "GET", path: R, expect: 405 });
await req("resend: no Origin -> 403", { path: R, expect: 403, noOrigin: true, ...J2("{}") });
await req("resend: wrong Origin -> 403", { path: R, expect: 403, ...J2("{}", { Origin: "https://evil.example" }) });
await req("resend: no cookie -> 401", { path: R, expect: 401, ...J2("{}") });
await req("resend: bogus 43-char token -> 401", { path: R, expect: 401, ...J2("{}", ck("A".repeat(43))) });
await req("resend: short token -> 401", { path: R, expect: 401, ...J2("{}", ck("abc")) });
await req("resend: duplicate cookies -> 401 ambiguous", { path: R, expect: 401, headers: { Cookie: `account_session=${"A".repeat(43)}; account_session=${"B".repeat(43)}` }, ...J2("{}") });
await req("resend: valid session, no CSRF -> 403", { path: R, expect: 403, ...J2("{}", ck(seeds.main.slotToken)) });
await req("resend: valid session, wrong CSRF -> 403", { path: R, expect: 403, ...J2("{}", { ...ck(seeds.main.slotToken), "x-csrf-token": "0".repeat(64) }) });
await req("resend: valid session+CSRF -> 503 mail_not_configured", { path: R, expect: 503, ...J2("{}", { ...ck(seeds.main.slotToken), "x-csrf-token": seeds.main.csrf }) });
await req("resend: garbage body ignored -> 503 (route never reads body)", { path: R, expect: 503, headers: { ...ck(seeds.main.slotToken), "x-csrf-token": seeds.main.csrf, "Content-Type": "text/plain" }, body: "not json {{{" });
await req("resend: 100KB unread body -> prompt 503, no hang", { path: R, expect: 503, timeoutMs: 8000, ...J2("x".repeat(100000), { ...ck(seeds.main.slotToken), "x-csrf-token": seeds.main.csrf }) });
await req("resend: verified account -> 200 already_verified", { path: R, expect: 200, ...J2("{}", { ...ck(seeds.extra1.slotToken), "x-csrf-token": seeds.extra1.csrf }) });
await req("resend: no-email account -> 422", { path: R, expect: 422, ...J2("{}", { ...ck(seeds.extra2.slotToken), "x-csrf-token": seeds.extra2.csrf }) });
await req("resend: malformed stored email -> 422", { path: R, expect: 422, ...J2("{}", { ...ck(seeds.extra3.slotToken), "x-csrf-token": seeds.extra3.csrf }) });

// ---------- rate floods (deliberately exhaust buckets; run last) ----------
// resend per-account bucket: 5/min on extra1 (1 prior use) -> flood i: overall 1+i; 429 when > 5, i.e. i >= 5
for (let i = 1; i <= 7; i++) {
  await req(`resend: flood ${i}/7`, { path: R, expect: i <= 4 ? 200 : 429, ...J2("{}", { ...ck(seeds.extra1.slotToken), "x-csrf-token": seeds.extra1.csrf }), note: i === 5 ? "first over-limit request" : "" });
}
// preview per-IP bucket: 30/min; ~27 counted pre-flood -> flood i: overall 27+i; 429 when > 30, i.e. i >= 4
for (let i = 1; i <= 12; i++) {
  await req(`preview: flood ${i}/12`, { path: P, expect: i <= 2 ? 410 : 429, ...J2(JSON.stringify({ inviteCode: validCode })), note: i >= 3 ? "expect 429 after bucket exhausts" : "" });
}

console.log(JSON.stringify({ results }, null, 1));
