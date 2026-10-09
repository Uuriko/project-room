// WAVE-2000 GUILD-02 WORKER 40 — shard fuzz battery.
// Shard: route-condition lines in server/http.mjs (sorted), indices where (index mod 50)==39
// over the guild's 107-line all-pathname-routes list (see worker-9/all-pathname-routes.txt;
// the launcher's app.(get|post|...) grep matches 0 lines — no express-style registrations exist).
//   index 39 -> line 40 -> http.mjs:1972  GET|HEAD /agents (acquisition page)
//   index 89 -> line 90 -> http.mjs:2940  POST /api/agent-invites/redeem
// Boots an acceptance-fixture server on 127.0.0.1 and probes both handlers for
// crash / hang / 500 / stack-leak / wrong-status.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import fs from "node:fs";

const outPath = new URL("./results.json", import.meta.url).pathname;
let server, fixture, base;

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

const looksLikeStack = (h) => /at\s+\S+\s*\(|Error:\s|\.mjs:\d+|node:internal/.test(h || "");

async function runCase(c) {
  const started = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), c.timeoutMs ?? 8000);
    const r = await fetch(base + c.path, {
      method: c.method || "GET", headers: c.headers || {},
      body: c.body ?? undefined, signal: ctl.signal, redirect: "manual",
    });
    clearTimeout(timer);
    const text = await r.text().catch(() => "");
    return { status: r.status, head: text.slice(0, 400), ms: Date.now() - started };
  } catch (e) {
    return { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR", head: String(e.message).slice(0, 200), ms: Date.now() - started };
  }
}

const J = (o) => JSON.stringify(o);
const big = (n) => "x".repeat(n);

const casesA = [
  { name: "A01 get agents", path: "/agents", expect: 200 },
  { name: "A02 head agents", path: "/agents", method: "HEAD", expect: 200 },
  { name: "A03 cursor garbage", path: "/agents?cursor=zzz-no-such", expect: 422 },
  { name: "A04 cursor empty", path: "/agents?cursor=", expect: 200 },
  { name: "A05 cursor sqli", path: "/agents?cursor=" + encodeURIComponent("' OR '1'='1"), expect: 422 },
  { name: "A06 cursor nullbyte", path: "/agents?cursor=" + encodeURIComponent("ab\x00cd"), expect: 422 },
  { name: "A07 ref xss probe", path: "/agents?ref=" + encodeURIComponent("<script>alert(1)</script>"), expect: 200, noReflect: "<script>alert(1)</script>" },
  { name: "A08 post agents", path: "/agents", method: "POST" },
  { name: "A09 put agents", path: "/agents", method: "PUT" },
  { name: "A10 agents.json suffix", path: "/agents.json" },
  { name: "A11 cursor 4000 chars", path: "/agents?cursor=" + big(4000), expect: 422 },
  { name: "A12 agents uppercase", path: "/AGENTS" },
  { name: "A13 cursor array param", path: "/agents?cursor=a&cursor=b" },
  { name: "A14 cursor unicode", path: "/agents?cursor=" + encodeURIComponent("é💣"), expect: 422 },
  { name: "A15 delete agents", path: "/agents", method: "DELETE" },
];

const casesB1 = [ // batch 1 (rate bucket 20/IP — stay under)
  { name: "B01 get redeem", path: "/api/agent-invites/redeem", expect: 405 },
  { name: "B02 post no content-type", path: "/api/agent-invites/redeem", method: "POST", body: J({}), expect: 415 },
  { name: "B03 post text/plain", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}", expect: 415 },
  { name: "B04 post empty body", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "0" }, expect: 400 },
  { name: "B05 post {}", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: J({}), expect: 422 },
  { name: "B06 post []", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: "[]", expect: 400 },
  { name: "B07 post null", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: "null", expect: 400 },
  { name: "B08 post string json", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: '"str"', expect: 400 },
  { name: "B09 post truncated json", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: '{"code":', expect: 400 },
  { name: "B10 code non-string", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: J({ code: 123, displayName: "x" }), expect: 422 },
];
const casesB2 = [ // batch 2 (fresh boot resets rate bucket)
  { name: "B11 unknown code valid format", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: J({ code: "AB-1234567890123456", displayName: "x" }), expect: 404 },
  { name: "B12 bad format code", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: J({ code: "bad", displayName: "x" }), expect: 404 },
  { name: "B13 extra field", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: J({ code: "AB-1234567890123456", displayName: "x", extra: 1 }), expect: 422 },
  { name: "B14 displayName non-string", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: J({ code: "AB-1234567890123456", displayName: { "__proto__": {} } }), expect: 422 },
  { name: "B15 displayName 81 chars", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: J({ code: "AB-1234567890123456", displayName: big(81) }), expect: 404 },
  { name: "B16 code null", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: J({ code: null, displayName: "x" }), expect: 422 },
  { name: "B17 put redeem", path: "/api/agent-invites/redeem", method: "PUT", expect: 405 },
  { name: "B18 post charset json", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: J({ code: "AB-1234567890123456", displayName: "x" }), expect: 404 },
  { name: "B19 code with I/L/O confusables", path: "/api/agent-invites/redeem", method: "POST", headers: { "Content-Type": "application/json" }, body: J({ code: "IL-OOOOOOOOOOOOOOOO", displayName: "x" }), expect: 404 },
];
const casesB3 = [ // batch 3: oversize declared body -> 413 (fresh boot)
  { name: "B20 declared oversize", path: "/api/agent-invites/redeem", method: "POST", raw: true, body: "x".repeat(70000), headers: { "Content-Type": "application/json" }, expect: 413 },
];

const findings = [];
async function runBatch(label, cases) {
  await boot();
  console.log(`booted ${base} for ${label}`);
  for (const c of cases) {
    const r = await runCase(c);
    const rec = { batch: label, case: c.name, method: c.method || "GET", path: c.path.slice(0, 120), status: r.status, ms: r.ms, expect: c.expect ?? null, head: r.head.slice(0, 200) };
    let verdict = null;
    if (looksLikeStack(r.head)) { verdict = "stack-leak"; }
    else if (r.status === 500) verdict = "unexpected-500";
    else if (r.status === "TIMEOUT") verdict = "hang";
    else if (c.noReflect && (r.head || "").includes(c.noReflect)) verdict = "reflected-xss";
    else if (c.expect != null && r.status !== c.expect) verdict = "wrong-status";
    if (verdict) { rec.verdict = verdict; findings.push(rec); console.log(`  FINDING ${c.name}: got ${r.status} (expect ${c.expect ?? "n/a"}) [${verdict}] ${(r.head || "").slice(0, 100)}`); }
    else console.log(`  ok ${c.name}: ${r.status}${c.expect != null && r.status !== c.expect ? " != " + c.expect : ""}`);
    if (!(await healthOk())) {
      findings.push({ batch: label, case: c.name, verdict: "crash", note: "server dead — restarted" });
      console.log("  CRASH — restarting"); await shutdown(); await boot();
    }
  }
  await shutdown();
}

await runBatch("A-agents", casesA);
await runBatch("B-redeem-1", casesB1);
await runBatch("B-redeem-2", casesB2);
await runBatch("B-redeem-3", casesB3);

fs.writeFileSync(outPath, JSON.stringify({ findings, findingCount: findings.length }, null, 1));
console.log(`done: ${findings.length} findings -> ${outPath}`);
