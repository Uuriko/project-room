// WAVE-2000 GUILD-02 WORKER-47 fuzz round 2: authenticated paths + boundaries.
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { setTimeout as delay } from "node:timers/promises";

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

async function req(method, path, { headers = {}, body = undefined } = {}) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(origin + path, { method, headers, body, signal: ctl.signal });
    const ms = Date.now() - t0;
    const text = await res.text().catch(() => "<unreadable>");
    return { status: res.status, ms, body: text, setCookie: res.headers.get("set-cookie") };
  } catch (e) {
    const ms = Date.now() - t0;
    if (e.name === "AbortError") return { status: "HANG", ms, body: "timeout" };
    return { status: "ERROR", ms, body: String(e).slice(0, 200) };
  } finally { clearTimeout(to); }
}
function check(name, got, expectStatus, extra = null) {
  const ok = got.status === expectStatus && (extra ? extra(got) : true);
  log(`${ok ? "ok  " : "FAIL"} ${name}: status=${got.status} (${got.ms}ms)${ok ? "" : ` expected=${expectStatus}`}`);
  if (got.status === "HANG" || got.status === 500 || got.status === "ERROR") finding(`${name}: ${got.status} — ${got.body.slice(0, 200)}`);
  else if (!ok) finding(`${name}: wrong status ${got.status}, expected ${expectStatus} — body: ${got.body.slice(0, 300)}`);
  if (got.ms > 5000 && got.status !== "HANG") finding(`${name}: latency ${got.ms}ms`);
  return got;
}

// ---- real account session via signup ----
const slot = f.store.createAccountSessionSlot();
const sres = await req("POST", "/api/auth/password/signup", {
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ email: "w47b@example.invalid", password: "fixture-password-w47b-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
});
log(`signup status=${sres.status}`);
const cookieVal = /account_session=([^;]+)/.exec(sres.setCookie || "")?.[1];
log(`session cookie: ${cookieVal ? cookieVal.slice(0, 10) + "..." : "NONE"}`);

// ---- H1 authenticated ----
log("\n--- H1 authenticated ---");
if (cookieVal) {
  const C = { Cookie: `account_session=${cookieVal}` };
  const r = await req("GET", "/api/auth/methods", { headers: C });
  await check("H1 GET authed", r, 200, (g) => {
    try {
      const j = JSON.parse(g.body);
      const okShape = Array.isArray(j.methods) && j.providers && typeof j.providers.github.configured === "boolean";
      if (!okShape) log(`  shape: ${g.body.slice(0, 300)}`);
      return okShape;
    } catch { log(`  unparsable: ${g.body.slice(0, 200)}`); return false; }
  });
  log(`  methods body: ${r.body.slice(0, 400)}`);
  // tampered cookie
  const tampered = cookieVal.slice(0, -2) + (cookieVal.endsWith("aa") ? "bb" : "aa");
  await check("H1 GET tampered cookie", await req("GET", "/api/auth/methods", { headers: { Cookie: `account_session=${tampered}` } }), 401);
  // session cookie + wrong CSRF-irrelevant GET: fine. Session in query (should NOT authenticate)
  await check("H1 GET session in query", await req("GET", `/api/auth/methods?account_session=${cookieVal}`), 401);
  // cookie with trailing junk
  await check("H1 GET cookie+suffix", await req("GET", "/api/auth/methods", { headers: { Cookie: `account_session=${cookieVal}xyz` } }), 401);
} else finding("setup: no session cookie from signup");

// ---- H2: pagination boundary + cursor semantics ----
log("\n--- H2 boundaries ---");
const mint = await req("POST", "/api/agent-identities", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "w47-b" }) });
const secret = JSON.parse(mint.body).secret;
const A = { Authorization: `Bearer ${secret}` };
// create a room so list is non-empty
const cr = await req("POST", "/api/agent-rooms", { headers: { ...A, "Content-Type": "application/json" }, body: JSON.stringify({ title: "w47 room", purpose: "fuzz" }) });
log(`create room: status=${cr.status}`);
const roomId = (() => { try { return JSON.parse(cr.body).roomId; } catch { return null; } })();
log(`roomId=${roomId}`);
const l1 = await req("GET", "/api/agent-rooms", { headers: A });
await check("H2 list non-empty", l1, 200, (g) => { try { return JSON.parse(g.body).rooms.length >= 1; } catch { return false; } });
if (roomId) {
  const l2 = await req("GET", `/api/agent-rooms?after=${roomId}`, { headers: A });
  await check("H2 after=own room id", l2, 200, (g) => { try { return JSON.parse(g.body).rooms.length === 0; } catch { return false; } });
}
// 128-char boundary: exactly 128 valid-id chars -> not length-rejected; 129 -> 422
const id128 = "r".repeat(128), id129 = "r".repeat(129);
const b128 = await req("GET", `/api/agent-rooms?after=${id128}`, { headers: A });
log(`after 128 chars: status=${b128.status} body=${b128.body.slice(0, 120)}`);
if (![200, 422].includes(b128.status)) finding(`H2 after=128chars: unexpected ${b128.status}`);
await check("H2 after=129chars", await req("GET", `/api/agent-rooms?after=${id129}`, { headers: A }), 422);
// rak_ unknown key
await check("H2 rak_ unknown", await req("GET", "/api/agent-rooms", { headers: { Authorization: "Bearer rak_" + "k".repeat(16) } }), 401);
// empty authorization value
await check("H2 empty auth header", await req("GET", "/api/agent-rooms", { headers: { Authorization: "" } }), 401);
// after with only whitespace
await check("H2 after=whitespace", await req("GET", "/api/agent-rooms?after=%20%20", { headers: A }), 422);

log(`\n==== DONE: ${findings.length} finding(s) ====`);
for (const x of findings) log(` * ${x}`);
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./fuzz2.log", import.meta.url), logLines.join("\n") + "\n");
server.closeStreams(); server.closeAllConnections();
await new Promise((r) => server.close(r));
f.store.close();
process.exit(0);
