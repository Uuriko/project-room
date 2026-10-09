// WAVE-2000 GUILD-02 WORKER-47 fuzz harness.
// Shard: worker 47 -> routes_all.txt 1-based lines L where L mod 50 == 46
//   L=46  -> server/http.mjs:2248  GET /api/auth/methods
//   L=96  -> server/http.mjs:3112  GET /api/agent-rooms
// Boots the real server in-process against an acceptance fixture and fuzzes
// both handlers: crash (500 / server death), hang (>8s), wrong-status.
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const TIMEOUT_MS = 8000;
const logLines = [];
const log = (m) => { logLines.push(m); console.log(m); };
const findings = [];
const finding = (m) => { findings.push(m); log(`FINDING: ${m}`); };

const f = createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
log(`server up at ${origin}`);

async function req(method, path, { headers = {}, body = undefined, rawBody = undefined } = {}) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(origin + path, {
      method, headers, body: rawBody ?? body, signal: ctl.signal,
    });
    const ms = Date.now() - t0;
    let text = "";
    try { text = await res.text(); } catch { text = "<body unreadable>"; }
    return { status: res.status, ms, body: text, preview: text.slice(0, 500), headers: Object.fromEntries([...res.headers].filter(([k]) => /^(content-type|allow|x-ratelimit)/i.test(k))) };
  } catch (e) {
    const ms = Date.now() - t0;
    if (e.name === "AbortError") return { status: "HANG", ms, body: `no response within ${TIMEOUT_MS}ms` };
    return { status: "ERROR", ms, body: String(e).slice(0, 300) };
  } finally { clearTimeout(to); }
}

function check(name, got, expectStatus, extra = null) {
  const ok = got.status === expectStatus && (extra ? extra(got) : true);
  log(`${ok ? "ok  " : "FAIL"} ${name}: status=${got.status} (${got.ms}ms)${ok ? "" : ` expected=${expectStatus}`}`);
  if (got.status === "HANG") finding(`${name}: request hung (no response in ${TIMEOUT_MS}ms)`);
  if (got.status === 500) finding(`${name}: 500 internal error — body: ${got.preview}`);
  if (got.status === "ERROR") finding(`${name}: transport error — ${got.body}`);
  if (!ok && got.status !== expectStatus && got.status !== "HANG" && got.status !== "ERROR" && got.status !== 500)
    finding(`${name}: wrong status ${got.status}, expected ${expectStatus}`);
  if (got.ms > 5000 && got.status !== "HANG") finding(`${name}: suspicious latency ${got.ms}ms`);
  return got;
}

// ---------- setup: mint agent identity + account session ----------
const mintRes = await req("POST", "/api/agent-identities", {
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "w47-fuzz" }),
});
const mintJson = JSON.parse(mintRes.body || "{}");
const agentSecret = mintJson.secret || mintJson.identitySecret;
log(`identity mint: status=${mintRes.status} secret=${agentSecret ? agentSecret.slice(0, 12) + "..." : "NONE"}`);
if (!agentSecret) finding("setup: could not mint agent identity — aborting agent-rooms authed tests");

let acctCookie = null;
try {
  const slot = f.store.createAccountSessionSlot();
  const sres = await req("POST", "/api/auth/password/signup", {
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email: "w47-fuzz@example.invalid", password: "fixture-password-w47-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
  });
  const m = /account_session=([^;]+)/.exec(sres.body || "") || /account_session=([^;]+)/.exec(JSON.stringify(sres.headers));
  // set-cookie isn't in sres.headers map reliably; refetch via raw header
  log(`signup: status=${sres.status}`);
} catch (e) { log(`signup setup error: ${e}`); }
// pull the session token directly from the store instead of parsing cookies
let sessionToken = null;
try {
  const s2 = f.store.createAccountSessionSlot();
  sessionToken = s2.token; // slot token usable as the session cookie value pre-signup? (may 401)
  log(`slot token acquired (may 401 pre-signup): ${sessionToken.slice(0, 8)}...`);
} catch (e) { log(`slot error: ${e}`); }

// ================= H1: GET /api/auth/methods (http.mjs:2248) =================
log("\n--- H1: /api/auth/methods ---");
await check("H1 GET no cookie", await req("GET", "/api/auth/methods"), 401);
await check("H1 GET garbage cookie", await req("GET", "/api/auth/methods", { headers: { Cookie: "account_session=garbage" } }), 401);
await check("H1 GET two session cookies", await req("GET", "/api/auth/methods", { headers: { Cookie: "account_session=a; account_session=b" } }), 401);
await check("H1 POST", await req("POST", "/api/auth/methods"), 405);
await check("H1 PUT", await req("PUT", "/api/auth/methods"), 405);
await check("H1 DELETE", await req("DELETE", "/api/auth/methods"), 405);
await check("H1 PATCH", await req("PATCH", "/api/auth/methods"), 405);
await check("H1 OPTIONS", await req("OPTIONS", "/api/auth/methods"), 405);
const headRes = await req("HEAD", "/api/auth/methods");
await check("H1 HEAD", headRes, 405, (g) => g.body.length === 0);
await check("H1 GET huge cookie", await req("GET", "/api/auth/methods", { headers: { Cookie: "account_session=" + "x".repeat(8000) } }), 401);
await check("H1 GET query garbage", await req("GET", "/api/auth/methods?" + "x".repeat(2000)), 401);
await check("H1 trailing slash", await req("GET", "/api/auth/methods/"), 404);
await check("H1 case variant", await req("GET", "/API/AUTH/METHODS"), 404);
if (sessionToken) {
  await check("H1 GET slot cookie (pre-signup)", await req("GET", "/api/auth/methods", { headers: { Cookie: `account_session=${sessionToken}` } }), 401);
}

// ================= H2: GET /api/agent-rooms (http.mjs:3112) =================
log("\n--- H2: /api/agent-rooms ---");
await check("H2 GET no auth", await req("GET", "/api/agent-rooms"), 401, (g) => g.body.includes("Unknown identity secret"));
await check("H2 GET bare 'Bearer'", await req("GET", "/api/agent-rooms", { headers: { Authorization: "Bearer" } }), 401);
await check("H2 GET short token", await req("GET", "/api/agent-rooms", { headers: { Authorization: "Bearer xyz" } }), 401);
await check("H2 GET wrong scheme", await req("GET", "/api/agent-rooms", { headers: { Authorization: "Basic abcdef" } }), 401);
await check("H2 GET token w/ spaces", await req("GET", "/api/agent-rooms", { headers: { Authorization: "Bearer  abc def " } }), 401);
const unknownSecret = "pri_" + "a".repeat(64);
await check("H2 GET unknown wellformed secret", await req("GET", "/api/agent-rooms", { headers: { Authorization: `Bearer ${unknownSecret}` } }), 401);
if (agentSecret) {
  const ok1 = await req("GET", "/api/agent-rooms", { headers: { Authorization: `Bearer ${agentSecret}` } });
  await check("H2 GET valid secret", ok1, 200, (g) => { try { const j = JSON.parse(g.body); return Array.isArray(j.rooms) && "nextCursor" in j; } catch { return false; } });
  await check("H2 GET lowercase bearer", await req("GET", "/api/agent-rooms", { headers: { Authorization: `bearer ${agentSecret}` } }), 200);
  await check("H2 GET after too long", await req("GET", `/api/agent-rooms?after=${"b".repeat(129)}`, { headers: { Authorization: `Bearer ${agentSecret}` } }), 422);
  await check("H2 GET after invalid id", await req("GET", "/api/agent-rooms?after=' OR '1'='1", { headers: { Authorization: `Bearer ${agentSecret}` } }), 422);
  await check("H2 GET after null byte", await req("GET", "/api/agent-rooms?after=%00", { headers: { Authorization: `Bearer ${agentSecret}` } }), 422);
  await check("H2 GET after empty", await req("GET", "/api/agent-rooms?after=", { headers: { Authorization: `Bearer ${agentSecret}` } }), 200);
  await check("H2 GET after 10k chars", await req("GET", `/api/agent-rooms?after=${"c".repeat(10000)}`, { headers: { Authorization: `Bearer ${agentSecret}` } }), 422);
  await check("H2 GET duplicate after params", await req("GET", "/api/agent-rooms?after=a&after=b", { headers: { Authorization: `Bearer ${agentSecret}` } }), 422);
  await check("H2 POST no secret", await req("POST", "/api/agent-rooms", { headers: { "Content-Type": "application/json" }, body: "{}" }), 401);
}
const h2head = await req("HEAD", "/api/agent-rooms");
await check("H2 HEAD", h2head, 405, (g) => g.body.length === 0 && (g.headers["allow"] || "").includes("GET"));
await check("H2 PUT", await req("PUT", "/api/agent-rooms"), 405);
await check("H2 DELETE", await req("DELETE", "/api/agent-rooms"), 405);

// rate-limit burst LAST (60/min per IP on agent-room-list)
log("\n--- H2 rate-limit burst (60/min) ---");
let first429 = -1, crashAt = -1;
for (let i = 0; i < 75; i++) {
  const r = await req("GET", "/api/agent-rooms", agentSecret ? { headers: { Authorization: `Bearer ${agentSecret}` } } : {});
  if (r.status === 429 && first429 === -1) first429 = i;
  if ((r.status === 500 || r.status === "HANG" || r.status === "ERROR") && crashAt === -1) { crashAt = i; finding(`H2 rate burst: bad response at i=${i}: ${r.status} ${r.preview.slice(0, 120)}`); }
}
log(`rate burst: first 429 at request #${first429}, crash/hang at #${crashAt}`);
if (first429 === -1) finding("H2 rate burst: never got 429 in 75 requests — rate limit may not be enforcing");

// server still alive?
const alive = await req("GET", "/api/health");
log(`post-burst /api/health: status=${alive.status}`);

log(`\n==== DONE: ${findings.length} finding(s) ====`);
for (const x of findings) log(` * ${x}`);

import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(new URL(".", import.meta.url), { recursive: true });
writeFileSync(new URL("./fuzz.log", import.meta.url), logLines.join("\n") + "\n");

server.closeStreams(); server.closeAllConnections();
await new Promise((r) => server.close(r));
f.store.close();
process.exit(0);
