// WAVE-2000 GUILD-02 WORKER 29 — shard fuzz for:
//   idx28: POST /api/account-rooms (server/http.mjs:2054)
//   idx78: /api/referral-invites/preview 405 guard (server/http.mjs:3032) + its POST handler (3031)
// Boots a local server on the acceptance fixture, runs adversarial cases, reports
// crash/hang/wrong-status. No git commit. No room posts.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const HEX64 = "ab".repeat(32); // valid-format session binding (64 hex)
const results = [];
let base = null, server = null, fixture = null;

async function boot() {
  fixture = await createAcceptanceFixture();
  server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function shutdown() {
  try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
  try { fixture.store.close(); } catch {}
}
async function healthOk() {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(base + "/api/health", { signal: c.signal }); clearTimeout(t);
    return r.status === 200;
  } catch { return false; }
}

async function req({ method = "GET", path = "/", headers = {}, body = undefined, rawBody = undefined, timeoutMs = 8000 }) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  const opts = { method, headers: { ...headers }, signal: c.signal };
  if (rawBody !== undefined) opts.body = rawBody;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
  const started = Date.now();
  try {
    const r = await fetch(base + path, opts);
    const text = await r.text();
    clearTimeout(t);
    return { status: r.status, body: text.slice(0, 500), ms: Date.now() - started };
  } catch (e) {
    clearTimeout(t);
    return { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR", body: e.message.slice(0, 200), ms: Date.now() - started };
  }
}

function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}
const codeOf = (r) => { try { const j = JSON.parse(r.body); return j?.error?.code ?? j?.code ?? "(no code)"; } catch { return "(non-json)"; } };

async function main() {
  await boot();
  console.log("booted", base, "health:", await healthOk());
  const CK = "account_session"; // scoped cookie name (http origin, no namespace)

  // ---- A. POST /api/account-rooms (idx 28, http.mjs:2054) ----
  let r = await req({ method: "POST", path: "/api/account-rooms", body: {} });
  check("A1 no-cookie+no-binding → 422 session_binding_required", r.status === 422 && codeOf(r) === "session_binding_required", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/account-rooms", headers: { "x-session-binding": "zzz" }, body: {} });
  check("A2 malformed binding header → 422 invalid_session_binding", r.status === 422 && codeOf(r) === "invalid_session_binding", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/account-rooms", headers: { "x-session-binding": HEX64 }, body: {} });
  check("A3 binding but no cookie → 401", r.status === 401, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/account-rooms", headers: { "x-session-binding": HEX64, cookie: `${CK}=zzz` }, body: {} });
  check("A4 garbage cookie → 401", r.status === 401, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/account-rooms", headers: { "x-session-binding": HEX64, cookie: `${CK}=a; ${CK}=b` }, body: {} });
  check("A5 duplicate session cookie → 401 ambiguous_session_cookie", r.status === 401 && codeOf(r) === "ambiguous_session_cookie", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/account-rooms?binding=zzz", headers: { "x-session-binding": HEX64 }, body: {} });
  console.log(`INFO  A6 header binding + mismatched query binding → ${r.status} ${codeOf(r)} (handler ignores query: accountBinding(req) without url)`);
  r = await req({ method: "POST", path: "/api/account-rooms?binding=zzz&binding=yyy" });
  check("A7 duplicate binding query params, no header → 422", r.status === 422 && codeOf(r) === "invalid_session_binding", `got ${r.status}/${codeOf(r)}`);
  // method matrix on existing resource
  for (const m of ["PUT", "PATCH", "DELETE"]) {
    r = await req({ method: m, path: "/api/account-rooms", headers: { "x-session-binding": HEX64, cookie: `${CK}=zzz` } });
    console.log(`INFO  ${m} /api/account-rooms → ${r.status} ${codeOf(r)}`);
  }
  r = await req({ method: "POST", path: "/api/account-rooms/", headers: { "x-session-binding": HEX64, cookie: `${CK}=zzz` } });
  console.log(`INFO  POST /api/account-rooms/ (trailing slash) → ${r.status} ${codeOf(r)}`);
  r = await req({ method: "POST", path: "/room/api/account-rooms", headers: { "x-session-binding": HEX64, cookie: `${CK}=zzz` } });
  console.log(`INFO  POST /room/api/account-rooms → ${r.status} ${codeOf(r)}`);
  r = await req({ method: "POST", path: "/API/account-rooms", headers: { "x-session-binding": HEX64, cookie: `${CK}=zzz` } });
  console.log(`INFO  POST /API/account-rooms (case) → ${r.status} ${codeOf(r)}`);
  r = await req({ method: "HEAD", path: "/api/account-rooms" });
  console.log(`INFO  HEAD /api/account-rooms → ${r.status} ${codeOf(r)}`);
  r = await req({ method: "OPTIONS", path: "/api/account-rooms" });
  console.log(`INFO  OPTIONS /api/account-rooms → ${r.status} ${codeOf(r)}`);
  // malformed bodies must not 500 even when unauthenticated
  r = await req({ method: "POST", path: "/api/account-rooms", headers: { "x-session-binding": HEX64, cookie: `${CK}=zzz`, "content-type": "application/json" }, rawBody: "{not json" });
  check("A8 invalid JSON body (unauth) → 401 or 400, never 5xx", r.status < 500, `got ${r.status}`);
  r = await req({ method: "POST", path: "/api/account-rooms", headers: { "x-session-binding": HEX64, cookie: `${CK}=zzz`, "content-type": "text/plain" }, rawBody: "hello" });
  check("A9 wrong content-type (unauth) → 401 or 415, never 5xx", r.status < 500, `got ${r.status}`);

  // ---- B. POST /api/referral-invites/preview handler (http.mjs:3031) ----
  r = await req({ method: "POST", path: "/api/referral-invites/preview", body: {} });
  check("B1 {} → 422 invalid_invite", r.status === 422 && codeOf(r) === "invalid_invite", `got ${r.status}/${codeOf(r)}`);
  for (const [nm, tok] of [["number", 123], ["array", ["x"]], ["object", {}], ["null", null], ["bool", true]]) {
    r = await req({ method: "POST", path: "/api/referral-invites/preview", body: { token: tok } });
    check(`B2 token=${nm} → 422 invalid_invite`, r.status === 422 && codeOf(r) === "invalid_invite", `got ${r.status}/${codeOf(r)}`);
  }
  r = await req({ method: "POST", path: "/api/referral-invites/preview", body: { token: "zzz", extra: 1 } });
  check("B3 extra field → 422 invalid_invite (exact gate)", r.status === 422 && codeOf(r) === "invalid_invite", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/referral-invites/preview", body: { token: "zzz" } });
  check("B4 garbage token string → 404 invite_unavailable", r.status === 404 && codeOf(r) === "invite_unavailable", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/referral-invites/preview", body: { token: "x".repeat(10000) } });
  check("B5 10k-char token → 404, no hang (ms<3000)", r.status === 404 && r.ms < 3000, `got ${r.status} in ${r.ms}ms`);
  r = await req({ method: "POST", path: "/api/referral-invites/preview", body: { token: "zzz\uD800\uDC00🎉" } });
  check("B6 unicode/surrogate token → 404, no 5xx", r.status < 500, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/referral-invites/preview", headers: { "content-type": "application/json" }, rawBody: "{oops" });
  check("B7 invalid JSON → 400 invalid_json", r.status === 400 && codeOf(r) === "invalid_json", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/referral-invites/preview", headers: { "content-type": "application/json" }, rawBody: "[1,2]" });
  check("B8 JSON array body → 400 invalid_json", r.status === 400 && codeOf(r) === "invalid_json", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/referral-invites/preview", headers: { "content-type": "application/json" }, rawBody: "null" });
  check("B9 null body → 400 invalid_json", r.status === 400 && codeOf(r) === "invalid_json", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/referral-invites/preview", headers: { "content-type": "text/plain" }, rawBody: "x" });
  check("B10 text/plain → 415 json_required", r.status === 415 && codeOf(r) === "json_required", `got ${r.status}/${codeOf(r)}`);
  const big = JSON.stringify({ token: "x".repeat(20000) });
  r = await req({ method: "POST", path: "/api/referral-invites/preview", headers: { "content-type": "application/json" }, rawBody: big });
  check("B11 20KB body (limit 16KB) → 413 too_large", r.status === 413 && codeOf(r) === "too_large", `got ${r.status}/${codeOf(r)}`);
  const protoBody = JSON.stringify(JSON.parse('{"token":"zzz","__proto__":{"polluted":1}}'));
  r = await req({ method: "POST", path: "/api/referral-invites/preview", headers: { "content-type": "application/json" }, rawBody: protoBody });
  check("B12 own __proto__ prop in body → 422 invalid_invite, no pollution", r.status === 422 && codeOf(r) === "invalid_invite" && ({}).polluted === undefined, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/referral-invites/preview?token=zzz", body: {} });
  console.log(`INFO  query token ignored, body gate still rules → ${r.status} ${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/referral-invites/preview/", body: { token: "zzz" } });
  console.log(`INFO  POST trailing slash → ${r.status} ${codeOf(r)}`);
  r = await req({ method: "POST", path: "/room/api/referral-invites/preview", body: { token: "zzz" } });
  check("B13 /room prefix rewrite → same 404 invite_unavailable", r.status === 404 && codeOf(r) === "invite_unavailable", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "OPTIONS", path: "/api/referral-invites/preview" });
  console.log(`INFO  OPTIONS /api/referral-invites/preview (CORS preflight) → ${r.status} ${codeOf(r)}`);

  // ---- C. 405 guard (idx 78, http.mjs:3032) ----
  for (const m of ["GET", "PUT", "PATCH", "DELETE", "HEAD"]) {
    r = await req({ method: m, path: "/api/referral-invites/preview" });
    check(`C1 ${m} → 405 method_not_allowed`, r.status === 405 && codeOf(r) === "method_not_allowed", `got ${r.status}/${codeOf(r)}`);
  }

  // ---- D. rate limit (bucket: referral-invite-preview:<addr>, 20/min) — fresh boot ----
  await shutdown(); await boot();
  console.log("rebooted for rate test, health:", await healthOk());
  let first429 = -1;
  for (let i = 1; i <= 25; i++) {
    r = await req({ method: "POST", path: "/api/referral-invites/preview", body: { token: "zzz" } });
    if (r.status === 429 && first429 < 0) first429 = i;
  }
  console.log(`INFO  rate-limit: first 429 at request #${first429} of 25`);
  check("D1 rate limiter engages (≈20/min)", first429 >= 19 && first429 <= 21, `first429=${first429}`);

  console.log("server alive after fuzz:", await healthOk());
  const fails = results.filter(x => !x.pass);
  console.log(`\n${results.length - fails.length}/${results.length} checks passed${fails.length ? "; FAILS: " + fails.map(f => f.name).join(" | ") : ""}`);
  await shutdown();
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error("FATAL", e); process.exit(2); });
