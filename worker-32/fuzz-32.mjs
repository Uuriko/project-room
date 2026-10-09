// WAVE-2000 GUILD-02 WORKER 32 fuzz script.
// Shard: server/http.mjs dispatch entries index%50==31 (path-sorted):
//   32 -> GET /api/auth/gmail/callback (http.mjs:1090)
//   81 -> HEAD /api/updates (http.mjs:3181; GET shares the same handler block)
// Boots a local server with the acceptance fixture on 127.0.0.1, hammers both
// endpoints with adversarial inputs, and reports crash/hang/wrong-status.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createAgentIdentity } from "../client/room-agent.mjs";

const results = [];
let base = null;

async function boot() {
  const fixture = await createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const origin = fixture.origin ?? base;
  const { secret } = await createAgentIdentity(origin, "w32-fuzz-bot");
  return { server, fixture, secret, origin };
}
async function shutdown(s) {
  try { s.server.closeStreams(); s.server.closeAllConnections(); await new Promise(r => s.server.close(r)); } catch {}
  try { s.fixture.store.close(); } catch {}
}
async function healthOk() {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(base + "/api/health", { signal: c.signal }); clearTimeout(t);
    return r.status === 200;
  } catch { return false; }
}

async function req(name, method, path, { headers = {}, expect = null, timeoutMs = 8000 } = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  let status = null, body = "", err = null;
  const t0 = Date.now();
  try {
    const r = await fetch(base + path, { method, headers, signal: c.signal });
    status = r.status; body = (await r.text()).slice(0, 400);
  } catch (e) { err = e.name === "AbortError" ? "TIMEOUT/HANG" : String(e).slice(0, 120); }
  clearTimeout(t);
  const ms = Date.now() - t0;
  const verdict = err ? "HANG/ERROR" : (expect === null ? "info" : (expect.includes(status) ? "ok" : "WRONG-STATUS"));
  results.push({ name, method, path: path.slice(0, 90), status, ms, verdict, err, body: body.replace(/\n/g, " ").slice(0, 140) });
  return { status, err };
}

const P = "pri_";

async function main() {
  const s = await boot();
  if (!await healthOk()) { console.log("BOOT FAILED: health not 200"); process.exit(2); }
  const auth = { Authorization: `Bearer ${s.secret}` };
  const badSecret = { Authorization: `Bearer ${P}${"A".repeat(43)}` }; // well-formed, unknown
  const garbageBearer = { Authorization: "Bearer garbage" };

  // ---------- A. GET /api/auth/gmail/callback (http.mjs:1090) ----------
  const G = "/api/auth/gmail/callback";
  await req("gmail plain", "GET", G, { expect: [200] });
  await req("gmail code+state", "GET", G + "?code=abc&state=xyz", { expect: [200] });
  await req("gmail error=access_denied", "GET", G + "?error=access_denied", { expect: [200] });
  await req("gmail dup params", "GET", G + "?code=1&code=2&state=a&state=b", { expect: [200] });
  await req("gmail huge query", "GET", G + "?" + "a".repeat(4000) + "=b", { expect: [200] });
  await req("gmail pct junk", "GET", G + "?code=%00%ff%zz&state=%2e%2e", { expect: [200] });
  await req("gmail junk cookie", "GET", G + "?code=x", { headers: { Cookie: "gmail_oauth=" + "z".repeat(500) }, expect: [200] });
  await req("gmail empty cookie", "GET", G, { headers: { Cookie: "gmail_oauth=" }, expect: [200] });
  for (const m of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
    await req(`gmail ${m}`, m, G, { expect: null }); // info: no 405 guard on this path; observe fall-through
  }

  // ---------- B. /api/updates GET+HEAD (http.mjs:3171-3183) ----------
  const U = "/api/updates";
  await req("updates no-auth GET", "GET", U, { expect: [401] });
  await req("updates no-auth HEAD", "HEAD", U, { expect: [401] });
  await req("updates garbage bearer", "GET", U, { headers: garbageBearer, expect: [401] });
  await req("updates unknown secret", "GET", U, { headers: badSecret, expect: [401] });
  await req("updates bad cookie", "GET", U, { headers: { Cookie: "prs=fakesessiontoken" }, expect: [401] });
  await req("updates ok GET", "GET", U, { headers: auth, expect: [200] });
  await req("updates ok HEAD", "HEAD", U, { headers: auth, expect: [200] });
  const q = (name, qs, expect, h = auth) => req(name, "GET", U + qs, { headers: h, expect });
  await q("limit=abc", "?limit=abc", [422]);
  await q("limit=-5", "?limit=-5", [422]);
  await q("limit=0", "?limit=0", [422]);
  await q("limit=101", "?limit=101", [422]);
  await q("limit=1.5", "?limit=1.5", [422]);
  await q("limit=unsafe-int", "?limit=100000000000000000000", [422]);
  await q("limit=empty", "?limit=", [422]);
  await q("limit=100", "?limit=100", [200]);
  await q("limit=1", "?limit=1", [200]);
  await q("limit dup", "?limit=10&limit=20", [422]);
  await q("unknown param", "?nope=1", [422]);
  await q("dup allowed param", "?state=all&state=actionable", [422]);
  await q("state bogus", "?state=bogus", [422]);
  await q("state all", "?state=all", [200]);
  await q("kinds bogus", "?kinds=bogus", [422]);
  await q("kinds empty", "?kinds=", [200]);
  await q("kinds trailing comma", "?kinds=mention,", [200]); // empty filtered -> kindList ["mention"]
  await q("kinds valid+bad", "?kinds=mention,bogus", [422]);
  await q("cursor garbage", "?cursor=!!!notbase64!!!", [422]);
  const badCur = Buffer.from(JSON.stringify({ v: 1 }), "utf8").toString("base64url");
  await q("cursor missing fields", "?cursor=" + badCur, [422]);
  const badCur2 = Buffer.from(JSON.stringify({ v: 1, viewer: "someone-else", id: "x", updatedAt: "y" }), "utf8").toString("base64url");
  await q("cursor wrong viewer", "?cursor=" + badCur2, [422]);
  await q("cursor huge", "?cursor=" + "A".repeat(10000), [422]);
  await q("auth param", "?auth=x", [200]);
  await q("binding param", "?binding=x", [200]);
  for (const m of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    await req(`updates ${m}`, m, U, { headers: auth, expect: [405] });
  }

  const alive = await healthOk();
  const crashes = results.filter(r => r.verdict === "HANG/ERROR");
  const wrong = results.filter(r => r.verdict === "WRONG-STATUS");
  console.log(JSON.stringify({ total: results.length, wrong: wrong.length, hangs: crashes.length, aliveAfter: alive }, null, 1));
  console.log("--- anomalies ---");
  for (const r of [...crashes, ...wrong]) console.log(JSON.stringify(r));
  console.log("--- fall-through observations (gmail non-GET) ---");
  for (const r of results.filter(r => r.name.startsWith("gmail ") && !["gmail plain","gmail code+state","gmail error=access_denied","gmail dup params","gmail huge query","gmail pct junk","gmail junk cookie","gmail empty cookie"].includes(r.name))) console.log(JSON.stringify({ name: r.name, status: r.status }));
  await shutdown(s);
}
main().catch(e => { console.error("FUZZ FATAL", e); process.exit(2); });
