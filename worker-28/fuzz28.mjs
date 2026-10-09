// WAVE-2000 GUILD-02 WORKER 28 — shard fuzz for (idx mod 50 == 27):
//   idx27:  POST /api/guest-invites/request               (server/http.mjs:2501)
//   idx77:  GET  /api/rooms/<id>/agent-grants             (server/http.mjs:4291)
//   idx127: POST /api/rooms/<id>/guest-invites-revoke-all (server/http.mjs:4685)
// Boots a local server on the acceptance fixture, runs adversarial cases, reports
// crash/hang/wrong-status. No git commit. No room posts.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const results = [];
let base = null, server = null, fixture = null, origin = null;
let OWNER = null, GUEST = null;
const ROOM = "commons";

async function boot() {
  fixture = await createAcceptanceFixture();
  OWNER = fixture.keys.owner; GUEST = fixture.keys.guest;
  server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  origin = `http://127.0.0.1:${server.address().port}`;
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
    return { status: r.status, body: text.slice(0, 600), ms: Date.now() - started };
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
const O = () => ({ origin });

async function main() {
  await boot();
  console.log("booted", base, "health:", await healthOk(), "room:", ROOM);

  // ================= H1: POST /api/guest-invites/request (idx 27, http.mjs:2501) =================
  let r = await req({ method: "POST", path: "/api/guest-invites/request", body: { card: "x" } });
  check("H1.1 no Origin → 403 origin_denied", r.status === 403 && codeOf(r) === "origin_denied", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: { origin: "https://evil.example" }, body: { card: "x" } });
  check("H1.2 foreign Origin → 403 origin_denied", r.status === 403 && codeOf(r) === "origin_denied", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: O(), body: {} });
  check("H1.3 {} → 422 card_invalid", r.status === 422 && codeOf(r) === "card_invalid", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: O(), body: { card: null } });
  check("H1.4 card=null → 4xx, no 5xx", r.status >= 400 && r.status < 500, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: O(), body: { card: 123 } });
  check("H1.5 card=number → 4xx, no 5xx", r.status >= 400 && r.status < 500, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: O(), body: { card: "garbage-card-string" } });
  check("H1.6 garbage card string → 4xx, no 5xx", r.status >= 400 && r.status < 500, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: O(), body: { card: {} } });
  check("H1.7 card={} → 4xx, no 5xx", r.status >= 400 && r.status < 500, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: O(), body: { card: "x", extra: 1 } });
  check("H1.8 extra field → 422 card_invalid (exact gate)", r.status === 422 && codeOf(r) === "card_invalid", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: { ...O(), "content-type": "application/json" }, rawBody: "{not json" });
  check("H1.9 invalid JSON → 400 invalid_json", r.status === 400 && codeOf(r) === "invalid_json", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: { ...O(), "content-type": "application/json" }, rawBody: "[1,2]" });
  check("H1.10 JSON array body → 400 invalid_json", r.status === 400 && codeOf(r) === "invalid_json", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: { ...O(), "content-type": "application/json" }, rawBody: "null" });
  check("H1.11 null body → 400 invalid_json", r.status === 400 && codeOf(r) === "invalid_json", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: { ...O(), "content-type": "text/plain" }, rawBody: "hello" });
  check("H1.12 text/plain → 415 json_required", r.status === 415 && codeOf(r) === "json_required", `got ${r.status}/${codeOf(r)}`);
  const big = JSON.stringify({ card: "x".repeat(20000) });
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: { ...O(), "content-type": "application/json" }, rawBody: big });
  check("H1.13 20KB body (limit 16KB) → 413 too_large", r.status === 413 && codeOf(r) === "too_large", `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: O(), body: { card: "x".repeat(100000) } });
  console.log(`INFO  H1.14 100KB card string → ${r.status} ${codeOf(r)} in ${r.ms}ms (no hang expected)`);
  check("H1.14b 100KB card string → 4xx, no hang (ms<5000)", r.status >= 400 && r.status < 500 && r.ms < 5000, `got ${r.status}/${codeOf(r)} in ${r.ms}ms`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: O(), body: JSON.parse('{"card":"x","__proto__":{"polluted":1}}') });
  check("H1.15 own __proto__ prop → no pollution, 4xx", ({}).polluted === undefined && r.status >= 400 && r.status < 500, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/guest-invites/request", headers: O(), body: { card: { joinRequest: { requestId: "x".repeat(5000), room: ROOM } } } });
  check("H1.16 deeply odd card shape → 4xx, no hang", r.status >= 400 && r.status < 500 && r.ms < 5000, `got ${r.status}/${codeOf(r)} in ${r.ms}ms`);
  for (const m of ["GET", "PUT", "PATCH", "DELETE"]) {
    r = await req({ method: m, path: "/api/guest-invites/request", headers: O() });
    console.log(`INFO  H1.17 ${m} /api/guest-invites/request → ${r.status} ${codeOf(r)}`);
  }
  r = await req({ method: "POST", path: "/api/guest-invites/request/", headers: O(), body: { card: "x" } });
  console.log(`INFO  H1.18 trailing slash → ${r.status} ${codeOf(r)}`);
  r = await req({ method: "POST", path: "/API/guest-invites/request", headers: O(), body: { card: "x" } });
  console.log(`INFO  H1.19 /API case variant → ${r.status} ${codeOf(r)}`);

  // ================= H2: GET /api/rooms/<id>/agent-grants (idx 77, http.mjs:4291) =================
  const gp = (room) => `/api/rooms/${encodeURIComponent(room)}/agent-grants`;
  r = await req({ path: gp(ROOM) });
  check("H2.1 no bearer → 401 unauthenticated", r.status === 401, `got ${r.status}/${codeOf(r)}`);
  r = await req({ path: gp(ROOM), headers: { authorization: "Bearer garbage" } });
  check("H2.2 garbage bearer → 401/403", r.status === 401 || r.status === 403, `got ${r.status}/${codeOf(r)}`);
  r = await req({ path: gp(ROOM), headers: { authorization: `Bearer ${OWNER}` } });
  check("H2.3 owner bearer → 200 JSON", r.status === 200, `got ${r.status}/${codeOf(r)}`);
  r = await req({ path: gp(ROOM), headers: { authorization: `Bearer ${GUEST}` } });
  check("H2.4 guest bearer → 403 (owner/delegate only)", r.status === 403, `got ${r.status}/${codeOf(r)}`);
  r = await req({ path: "/api/rooms/no-such-room/agent-grants", headers: { authorization: `Bearer ${OWNER}` } });
  check("H2.5 unknown room → 4xx, no 5xx", r.status >= 400 && r.status < 500, `got ${r.status}/${codeOf(r)}`);
  r = await req({ path: gp("x".repeat(2000)), headers: { authorization: `Bearer ${OWNER}` } });
  check("H2.6 2000-char room id → 4xx, no hang", r.status >= 400 && r.status < 500 && r.ms < 5000, `got ${r.status}/${codeOf(r)} in ${r.ms}ms`);
  r = await req({ path: gp("../etc/passwd"), headers: { authorization: `Bearer ${OWNER}` } });
  console.log(`INFO  H2.7 traversal room id → ${r.status} ${codeOf(r)}`);
  r = await req({ path: gp(ROOM) + "?limit=abc&foo=bar", headers: { authorization: `Bearer ${OWNER}` } });
  console.log(`INFO  H2.8 query params on grant list → ${r.status} ${codeOf(r)} (handler takes no params)`);
  r = await req({ path: gp(ROOM), headers: { authorization: `Bearer ${OWNER}`, "x-session-binding": "zzz" } });
  console.log(`INFO  H2.9 malformed x-session-binding (bearer) → ${r.status} ${codeOf(r)}`);
  for (const m of ["PUT", "PATCH", "DELETE"]) {
    r = await req({ method: m, path: gp(ROOM), headers: { authorization: `Bearer ${OWNER}` } });
    console.log(`INFO  H2.10 ${m} agent-grants (owner) → ${r.status} ${codeOf(r)}`);
  }

  // ================= H3: POST /api/rooms/<id>/guest-invites-revoke-all (idx 127, http.mjs:4685) =================
  const rp = (room) => `/api/rooms/${encodeURIComponent(room)}/guest-invites-revoke-all`;
  r = await req({ method: "POST", path: rp(ROOM) });
  check("H3.1 no bearer → 401 unauthenticated", r.status === 401, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: rp(ROOM), headers: { authorization: "Bearer garbage" } });
  check("H3.2 garbage bearer → 401/403", r.status === 401 || r.status === 403, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: rp(ROOM), headers: { authorization: `Bearer ${GUEST}` } });
  check("H3.3 guest bearer → 403", r.status === 403, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: "/api/rooms/no-such-room/guest-invites-revoke-all", headers: { authorization: `Bearer ${OWNER}` } });
  check("H3.4 unknown room → 4xx, no 5xx", r.status >= 400 && r.status < 500, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: rp(ROOM), headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" }, rawBody: "{bad json" });
  check("H3.5 owner + bad JSON (no body read) → 200", r.status === 200, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: rp(ROOM), headers: { authorization: `Bearer ${OWNER}` }, body: { extra: [1, { x: "y" }] } });
  check("H3.6 owner + junk body → 200 (body ignored)", r.status === 200, `got ${r.status}/${codeOf(r)}`);
  r = await req({ method: "POST", path: rp(ROOM), headers: { authorization: `Bearer ${OWNER}`, "content-type": "text/plain" }, rawBody: "hello" });
  console.log(`INFO  H3.7 owner + text/plain (no body read) → ${r.status} ${codeOf(r)}`);
  for (const m of ["GET", "PUT", "DELETE"]) {
    r = await req({ method: m, path: rp(ROOM), headers: { authorization: `Bearer ${OWNER}` } });
    console.log(`INFO  H3.8 ${m} revoke-all (owner) → ${r.status} ${codeOf(r)}`);
  }

  // ================= H1 rate limit: fresh boot, 10/min per IP =================
  await shutdown(); await boot();
  console.log("rebooted for H1 rate test, health:", await healthOk());
  let first429 = -1;
  for (let i = 1; i <= 14; i++) {
    r = await req({ method: "POST", path: "/api/guest-invites/request", headers: O(), body: {} });
    if (r.status === 429 && first429 < 0) first429 = i;
  }
  console.log(`INFO  H1 rate-limit: first 429 at request #${first429} of 14`);
  check("H1.19 rate limiter engages (≈10/min)", first429 >= 10 && first429 <= 11, `first429=${first429}`);

  console.log("server alive after fuzz:", await healthOk());
  const fails = results.filter(x => !x.pass);
  console.log(`\n${results.length - fails.length}/${results.length} checks passed${fails.length ? "; FAILS: " + fails.map(f => f.name).join(" | ") : ""}`);
  await shutdown();
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error("FATAL", e); process.exit(2); });
