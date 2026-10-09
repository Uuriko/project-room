// WAVE-2000 guild-02 worker-6 fuzz harness.
// Shard: sorted unique exact-path route handlers in server/http.mjs, (index mod 50) == 5
//   -> /api/account-rooms (GET + POST), /api/public-work/match (POST)
// Runs a local server (acceptance fixture store), fires malformed/edge cases,
// records crash/hang/wrong-status findings.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { writeFileSync } from "node:fs";

const W = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const findings = [];
const stats = { cases: 0, byStatus: {} };

const fixture = await createAcceptanceFixture();
const store = fixture.store;
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const origin = base;

// ---- auth setup: two accounts with logged-in browser sessions ----
function loginAccount(accountId) {
  store.createAccount(accountId);
  const cred = store.issueAccountAccessKey(accountId);
  const accessKey = typeof cred === "string" ? cred : (cred?.token ?? cred?.key ?? cred?.accessKey);
  const slot = store.createAccountSessionSlot();
  store.loginAccountSession(slot.token, accessKey, 0);
  const auth = store.authenticateAccountSession(slot.token, null, null);
  return { token: slot.token, binding: auth.sessionBinding, csrf: auth.csrf };
}
const A = loginAccount("w6acct1");
const B = loginAccount("w6acct2");
const authHeaders = (acct, extra = {}) => ({
  "Cookie": `account_session=${acct.token}`,
  "X-Session-Binding": acct.binding,
  "X-CSRF-Token": acct.csrf,
  "Origin": origin,
  ...extra,
});
console.log("booted", base, "auth A ready");

async function req(name, method, path, { headers = {}, rawBody = null, jsonBody = undefined, contentType = "application/json", timeoutMs = 8000 } = {}) {
  stats.cases++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  const t0 = Date.now();
  try {
    const init = { method, headers: { ...headers }, signal: ctl.signal };
    if (jsonBody !== undefined) { init.headers["Content-Type"] = contentType; init.body = JSON.stringify(jsonBody); }
    else if (rawBody !== null) { init.headers["Content-Type"] = contentType; init.body = rawBody; }
    const r = await fetch(base + path, init);
    const ms = Date.now() - t0;
    const text = await r.text().catch(() => "<unreadable>");
    stats.byStatus[r.status] = (stats.byStatus[r.status] || 0) + 1;
    const rec = { name, method, path, status: r.status, ms, body: text.slice(0, 300) };
    if (r.status >= 500) { rec.flag = "5xx"; findings.push(rec); console.log("FINDING", name, r.status, text.slice(0, 160)); }
    return rec;
  } catch (e) {
    const ms = Date.now() - t0;
    const rec = { name, method, path, status: "ERROR/HANG", ms, error: String(e && e.message || e) };
    rec.flag = "hang-or-error";
    findings.push(rec);
    console.log("FINDING", name, "ERROR/HANG", rec.error);
    return rec;
  } finally { clearTimeout(timer); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============ T1: method matrix, unauthenticated ============
console.log("T1 method matrix");
for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
  await req(`T1 acct-rooms ${m} unauth`, m, "/api/account-rooms");
  await req(`T1 match ${m} unauth`, m, "/api/public-work/match");
}

// ============ T2: GET /api/account-rooms query fuzz ============
console.log("T2 account-rooms GET query");
const q = (name, path, acct = null) => req(name, "GET", path, acct ? { headers: authHeaders(acct) } : {});
await q("T2 no-binding", "/api/account-rooms");
await req("T2 bad-binding", "GET", "/api/account-rooms", { headers: { "X-Session-Binding": "zzz" } });
await req("T2 binding-via-query-only", "GET", "/api/account-rooms", { headers: {} });
await req("T2 binding-query", "GET", `/api/account-rooms?binding=${A.binding}`);
await req("T2 binding-query-mismatch", "GET", `/api/account-rooms?binding=${A.binding}`, { headers: { "X-Session-Binding": B.binding } });
await req("T2 binding-query-dup", "GET", `/api/account-rooms?binding=${A.binding}&binding=${A.binding}`);
await q("T2 after-dup", "/api/account-rooms?after=a&after=b", A);
await q("T2 after-empty", "/api/account-rooms?after=", A);
await q("T2 after-valid", "/api/account-rooms?after=abc123", A);
await q("T2 after-proto", "/api/account-rooms?after=__proto__", A);
await q("T2 after-constructor", "/api/account-rooms?after=constructor", A);
await q("T2 after-long", "/api/account-rooms?after=" + "a".repeat(10000), A);
await q("T2 after-128", "/api/account-rooms?after=" + "a".repeat(128), A);
await q("T2 after-129", "/api/account-rooms?after=" + "a".repeat(129), A);
await q("T2 after-unicode", "/api/account-rooms?after=" + encodeURIComponent("röö m"), A);
await q("T2 after-nul", "/api/account-rooms?after=a%00b", A);
await q("T2 after-slash", "/api/account-rooms?after=a/b", A);
await q("T2 unknown-param", "/api/account-rooms?foo=bar", A);
await q("T2 after-case", "/api/account-rooms?AFTER=x", A);
await q("T2 ok", "/api/account-rooms", A);

// ============ T3: POST /api/account-rooms body fuzz ============
console.log("T3 account-rooms POST body");
const validRoom = (id = "w6room1") => ({ roomId: id, title: "T", purpose: "P", kind: "personal", displayName: "W6" });
const p3 = (name, opts = {}) => req(name, "POST", "/api/account-rooms", { headers: authHeaders(A), ...opts });
await p3("T3 no-body", {});
await p3("T3 empty-body", { rawBody: "" });
await p3("T3 invalid-json", { rawBody: "{oops" });
await p3("T3 json-null", { rawBody: "null" });
await p3("T3 json-number", { rawBody: "42" });
await p3("T3 json-string", { rawBody: "\"hi\"" });
await p3("T3 json-array", { rawBody: "[1,2]" });
await p3("T3 wrong-ct", { rawBody: "{}", contentType: "text/plain" });
await p3("T3 no-ct", { rawBody: "{}", contentType: "" });
await p3("T3 ct-charset", { rawBody: JSON.stringify(validRoom("w6room1")), contentType: "application/json; charset=utf-8" });
await p3("T3 ct-case", { rawBody: JSON.stringify(validRoom("w6room1")), contentType: "Application/JSON" });
await p3("T3 proto-key", { rawBody: '{"__proto__":{"x":1},"roomId":"w6roomX","title":"T","purpose":"P","kind":"personal","displayName":"W6"}' });
await p3("T3 missing-fields", { jsonBody: { roomId: "w6roomX" } });
await p3("T3 extra-field", { jsonBody: { ...validRoom("w6roomX"), hacker: 1 } });
await p3("T3 title-long", { jsonBody: { ...validRoom("w6roomX"), title: "t".repeat(121) } });
await p3("T3 title-control", { jsonBody: { ...validRoom("w6roomX"), title: "a\u0007b" } });
await p3("T3 title-empty", { jsonBody: { ...validRoom("w6roomX"), title: "   " } });
await p3("T3 title-not-string", { jsonBody: { ...validRoom("w6roomX"), title: 5 } });
await p3("T3 purpose-long", { jsonBody: { ...validRoom("w6roomX"), purpose: "p".repeat(1001) } });
await p3("T3 roomid-65", { jsonBody: { ...validRoom("a".repeat(65)) } });
await p3("T3 roomid-proto", { jsonBody: { ...validRoom("__proto__") } });
await p3("T3 roomid-slash", { jsonBody: { ...validRoom("a/b") } });
await p3("T3 roomid-space", { jsonBody: { ...validRoom("a b") } });
await p3("T3 kind-bad", { jsonBody: { ...validRoom("w6roomX"), kind: "admin" } });
await p3("T3 displayname-long", { jsonBody: { ...validRoom("w6roomX"), displayName: "d".repeat(81) } });
await p3("T3 start-zero", { jsonBody: { ...validRoom("w6roomX"), start: 0 } });
await p3("T3 start-string", { jsonBody: { ...validRoom("w6roomX"), start: "1" } });
await p3("T3 intent-long", { jsonBody: { ...validRoom("w6roomX"), intent: "i".repeat(81) } });
await p3("T3 template-bad", { jsonBody: { ...validRoom("w6roomX"), templateSlug: "nope" } });
await p3("T3 nested-deep", { rawBody: '{"roomId":"w6roomX","title":"T","purpose":"P","kind":"personal","displayName":"W6","x":' + "[".repeat(5000) + "]".repeat(5000) + "}" });
await p3("T3 huge-body", { rawBody: "x".repeat(20000) });
await p3("T3 body-at-limit", { rawBody: JSON.stringify({ ...validRoom("w6roomX"), title: "t".repeat(120) }).padEnd(16384, " ") });
// auth/csrf edge cases
await req("T3 no-cookie", "POST", "/api/account-rooms", { headers: { "X-Session-Binding": A.binding, "X-CSRF-Token": A.csrf, "Origin": origin }, rawBody: "{}", contentType: "application/json" });
await req("T3 bad-cookie", "POST", "/api/account-rooms", { headers: authHeaders(A, { "Cookie": "account_session=deadbeef" }), rawBody: "{}", contentType: "application/json" });
await req("T3 dup-cookie", "POST", "/api/account-rooms", { headers: authHeaders(A, { "Cookie": `account_session=${A.token}; account_session=${B.token}` }), rawBody: "{}", contentType: "application/json" });
await req("T3 no-csrf", "POST", "/api/account-rooms", { headers: (() => { const h = authHeaders(A); delete h["X-CSRF-Token"]; return h; })(), rawBody: "{}", contentType: "application/json" });
await req("T3 bad-csrf", "POST", "/api/account-rooms", { headers: authHeaders(A, { "X-CSRF-Token": "0".repeat(64) }), rawBody: "{}", contentType: "application/json" });
await req("T3 no-origin", "POST", "/api/account-rooms", { headers: (() => { const h = authHeaders(A); delete h["Origin"]; return h; })(), rawBody: "{}", contentType: "application/json" });
await req("T3 bad-origin", "POST", "/api/account-rooms", { headers: authHeaders(A, { "Origin": "https://evil.example" }), rawBody: "{}", contentType: "application/json" });
// happy path + idempotency + 409 conflict
const r1 = await p3("T3 create-ok", { jsonBody: validRoom("w6room1") });
const r2 = await p3("T3 create-dup", { jsonBody: validRoom("w6room1") });
console.log("create statuses:", r1.status, r2.status, r1.body.slice(0, 120), "|", r2.body.slice(0, 120));
// 429 behavior with a fresh account (10/min window)
const C = loginAccount("w6acct3");
let last429 = null;
for (let i = 0; i < 12; i++) {
  const r = await req(`T3 rate-${i}`, "POST", "/api/account-rooms", { headers: authHeaders(C), jsonBody: validRoom(`w6rate${i}`) });
  if (r.status === 429) last429 = i;
  await sleep(50);
}
console.log("first-429-at:", last429);

// ============ T4: POST /api/public-work/match fuzz ============
console.log("T4 match");
const m4 = (name, opts = {}) => req(name, "POST", "/api/public-work/match", opts);
await m4("T4 empty-obj");
await m4("T4 no-body", {});
await m4("T4 invalid-json", { rawBody: "{bad" });
await m4("T4 json-array", { rawBody: "[1]" });
await m4("T4 wrong-ct", { rawBody: "{}", contentType: "text/plain" });
await m4("T4 extra-field", { jsonBody: { nope: 1 } });
await m4("T4 limit-0", { jsonBody: { limit: 0 } });
await m4("T4 limit-6", { jsonBody: { limit: 6 } });
await m4("T4 limit-float", { jsonBody: { limit: 1.5 } });
await m4("T4 limit-string", { jsonBody: { limit: "3" } });
await m4("T4 limit-huge", { jsonBody: { limit: 1e999 } });
await m4("T4 limit-neg", { jsonBody: { limit: -2 } });
await m4("T4 reward-bad", { jsonBody: { reward: "gold" } });
await m4("T4 reward-cash", { jsonBody: { reward: "cash" } });
await m4("T4 skills-21", { jsonBody: { skills: Array.from({ length: 21 }, (_, i) => "s" + i) } });
await m4("T4 skills-101char", { jsonBody: { skills: ["x".repeat(101)] } });
await m4("T4 skills-empty-str", { jsonBody: { skills: [""] } });
await m4("T4 skills-nonstring", { jsonBody: { skills: [123] } });
await m4("T4 skills-control", { jsonBody: { skills: ["a\nb"] } });
await m4("T4 skills-notarray", { jsonBody: { skills: { a: 1 } } });
await m4("T4 interests-ok", { jsonBody: { interests: ["music", "code"] } });
await m4("T4 autoclaim-string", { jsonBody: { autoClaim: "true" } });
await m4("T4 autoclaim-true-nocred", { jsonBody: { autoClaim: true } });
await m4("T4 autoclaim-false", { jsonBody: { autoClaim: false } });
await m4("T4 bearer-malformed", { headers: { "Authorization": "Bearer xyz" }, jsonBody: {} });
await m4("T4 bearer-unknown43", { headers: { "Authorization": "Bearer " + "A".repeat(43) }, jsonBody: {} });
await m4("T4 bearer-unknown-autoclaim", { headers: { "Authorization": "Bearer " + "A".repeat(43) }, jsonBody: { autoClaim: true } });
await m4("T4 requestid-proto", { jsonBody: { requestId: "__proto__" } });
await m4("T4 requestid-ok", { jsonBody: { requestId: "req-1" } });
await m4("T4 after-bad", { jsonBody: { after: "!!" } });
await m4("T4 after-ok", { jsonBody: { after: "cursor1" } });
await m4("T4 lease-string", { jsonBody: { leaseHours: "6" } });
await m4("T4 lease-zero", { jsonBody: { leaseHours: 0 } });
await m4("T4 lease-25", { jsonBody: { leaseHours: 25 } });
await m4("T4 lease-half", { jsonBody: { leaseHours: 0.5 } });
await m4("T4 lease-nan-str", { rawBody: '{"leaseHours": NaN}' });
await m4("T4 huge-body", { rawBody: "x".repeat(20000) });
await req("T4 query-param", "POST", "/api/public-work/match?x=1", { jsonBody: {} });
await req("T4 query-param-get", "GET", "/api/public-work/match?x=1");

writeFileSync(`${W}/findings.jsonl`, findings.map(f => JSON.stringify(f)).join("\n"));
console.log("CASES:", stats.cases, "FINDINGS:", findings.length);
console.log("BY-STATUS:", JSON.stringify(stats.byStatus));
server.closeStreams(); server.closeAllConnections();
await new Promise(r => server.close(r));
store.close();
console.log("DONE");
