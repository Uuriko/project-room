// WAVE-2000 GUILD-02 WORKER 8 — shard fuzz.
// Canonical routes list: worker-1/routes_all.txt (102 entries, 1-based).
// Worker 8 takes 0-based indices (i%50)==7 -> 1-based lines 8 and 58:
//   line 8:  server/http.mjs:1214  POST /api/auth/email/verify/resend
//   line 58: server/http.mjs:2398  POST /api/account/delete
import net from "node:net";
import assert from "node:assert/strict";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { methodMatrix, jsonCases, invalidUtf8Case, queryCases, headerCases } from "../fuzz/adversarial.mjs";

const findings = [];
let server = null, fixture = null, base = null, port = null;
let crashes = 0;

async function boot() {
  fixture = await createAcceptanceFixture();
  server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
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

async function rawRequest(payload, timeoutMs) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1");
    let data = ""; let done = false;
    const finish = (result) => { if (!done) { done = true; sock.destroy(); resolve(result); } };
    const timer = setTimeout(() => finish({ status: "TIMEOUT", head: data.slice(0, 300) }), timeoutMs);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", d => { data += d.toString("latin1"); });
    sock.on("close", () => { clearTimeout(timer); finish({ status: "CLOSED", head: data.slice(0, 300) }); });
    sock.on("error", e => { clearTimeout(timer); finish({ status: "SOCKET-ERROR", head: e.message.slice(0, 200) }); });
    setTimeout(() => { if (!done && data) { clearTimeout(timer); finish({ status: "RESP", head: data.slice(0, 300) }); } }, Math.min(timeoutMs, 2500));
  });
}

async function runCase(c) {
  const started = Date.now();
  try {
    if (c.raw === true) {
      const r = await rawRequest(c.payload, c.timeoutMs);
      return { ...r, ms: Date.now() - started };
    }
    const headers = { ...c.headers };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), c.timeoutMs);
    const r = await fetch(base + c.path, {
      method: c.method, headers,
      body: c.raw ?? c.body ?? undefined,
      signal: ctl.signal, redirect: "manual",
    });
    clearTimeout(timer);
    const text = await r.text().catch(() => "");
    return { status: r.status, head: text.slice(0, 300), ms: Date.now() - started };
  } catch (e) {
    return { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR", head: String(e.message).slice(0, 200), ms: Date.now() - started };
  }
}

const looksLikeStack = (h) => /at\s+\S+\s*\(|Error:\s|\.mjs:\d+|node:internal/.test(h);

function record(route, c, r, expect) {
  const rec = { route, case: c.name, method: c.method || "RAW", status: r.status, ms: r.ms, head: r.head, expect: expect ?? null };
  const bad = r.status === "TIMEOUT" || r.status === "FETCH-ERROR" || looksLikeStack(r.head)
    || (typeof r.status === "number" && r.status >= 500)
    || (expect !== undefined && expect !== null && r.status !== expect);
  if (bad) findings.push(rec);
  return rec;
}

// ---------- account setup ----------
const post = (origin, path, data, cookie = null) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(data)
});

async function makeAccount(n, { verified = true } = {}) {
  const f = fixture; const origin = base;
  const email = `w8-shard8-${n}-${Date.now() % 100000}@example.invalid`;
  const slot = f.store.createAccountSessionSlot();
  const res = await post(origin, "/api/auth/password/signup", {
    email, password: `fixture-password-${n}-long-enough`, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision
  });
  assert.equal(res.status, 202, await res.clone().text());
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  assert.ok(token, "signup sets account_session cookie");
  const session = f.store.authenticateAccountSession(token);
  if (verified) f.store.accountLogins.markEmailVerified(session.account.id, email);
  return {
    email, token, binding: session.sessionBinding, accountId: session.account.id,
    auth: {
      "Content-Type": "application/json", Origin: origin,
      Cookie: `account_session=${token}`, "X-CSRF-Token": session.csrf,
    },
  };
}

await boot();
console.log(`worker-8 booted ${base}`);

const R1 = "/api/auth/email/verify/resend";
const R2 = "/api/account/delete";

// Control: resend with verified email -> already_verified
const acctVerified = await makeAccount(1, { verified: true });
const acctUnverified = await makeAccount(2, { verified: false });
const acctDeleter = await makeAccount(3, { verified: true });

let r = await runCase({ name: "control:resend-verified", method: "POST", path: R1, headers: acctVerified.auth, body: "{}", timeoutMs: 8000 });
record(R1, { name: "control:resend-verified" }, r, 200);
console.log("control resend verified:", r.status, r.head.slice(0, 120));

// Control: resend with unverified email (mailer unconfigured -> 503 expected, or resent)
r = await runCase({ name: "control:resend-unverified", method: "POST", path: R1, headers: acctUnverified.auth, body: "{}", timeoutMs: 8000 });
console.log("control resend unverified:", r.status, r.head.slice(0, 120));

// ---------- R1: method matrix ----------
for (const c of methodMatrix(R1)) {
  const rr = await runCase({ ...c, headers: acctVerified.auth });
  record(R1, c, rr, 405);
}
// raw TRACE against R1
{
  const c = { name: "method-matrix:TRACE-raw", raw: true, payload: `TRACE ${R1} HTTP/1.1\r\nHost: x\r\n\r\n`, timeoutMs: 8000 };
  const rr = await runCase(c);
  const st = / (\d{3}) /.exec(rr.head)?.[1];
  record(R1, c, rr, null);
  if (st && st !== "405" && st !== "501") findings.push({ route: R1, case: c.name, method: "TRACE", status: st, note: "unexpected trace status" });
}

// ---------- R1: auth edges ----------
const authEdges = [
  { name: "auth:no-cookie", headers: { "Content-Type": "application/json", Origin: base }, body: "{}", expect: 401 },
  { name: "auth:garbage-cookie", headers: { "Content-Type": "application/json", Origin: base, Cookie: "account_session=garbage" }, body: "{}", expect: 401 },
  { name: "auth:foreign-origin", headers: { ...acctVerified.auth, Origin: "https://evil.example.com" }, body: "{}", expect: 403 },
  { name: "auth:missing-origin", headers: { "Content-Type": "application/json", Cookie: acctVerified.auth.Cookie, "X-CSRF-Token": acctVerified.auth["X-CSRF-Token"] }, body: "{}", expect: 403 },
  { name: "auth:missing-csrf", headers: { "Content-Type": "application/json", Origin: base, Cookie: acctVerified.auth.Cookie }, body: "{}", expect: 403 },
  { name: "auth:wrong-csrf", headers: { ...acctVerified.auth, "X-CSRF-Token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, body: "{}", expect: 403 },
];
for (const e of authEdges) {
  const rr = await runCase({ name: e.name, method: "POST", path: R1, headers: e.headers, body: e.body, timeoutMs: 8000 });
  record(R1, { name: e.name }, rr, e.expect);
}

// ---------- R1: body fuzz (authed) ----------
for (const c of jsonCases(R1, "POST", { Origin: base, Cookie: acctVerified.auth.Cookie, "X-CSRF-Token": acctVerified.auth["X-CSRF-Token"] })) {
  const rr = await runCase(c);
  record(R1, c, rr, null);
}
{
  const rr = await runCase({ ...invalidUtf8Case(R1), headers: { "Content-Type": "application/json", Origin: base, Cookie: acctVerified.auth.Cookie, "X-CSRF-Token": acctVerified.auth["X-CSRF-Token"] } });
  record(R1, { name: "json:invalid-utf8" }, rr, null);
}

// ---------- R1: rate limit (5 per account) ----------
console.log("R1 rate-limit probe...");
const rlStatuses = [];
for (let i = 0; i < 7; i++) {
  const rr = await runCase({ name: `ratelimit:attempt-${i + 1}`, method: "POST", path: R1, headers: acctDeleter.auth, body: "{}", timeoutMs: 8000 });
  rlStatuses.push(rr.status);
}
console.log("R1 rate-limit statuses:", JSON.stringify(rlStatuses));
if (!rlStatuses.includes(429)) findings.push({ route: R1, case: "ratelimit", note: "no 429 after 7 rapid resends", statuses: rlStatuses });

// ---------- R2: /api/account/delete ----------
const planRes = await fetch(base + "/api/account/deletion/plan", { headers: { Cookie: acctDeleter.auth.Cookie } });
const plan = await planRes.json();
console.log("deletion plan status:", planRes.status, JSON.stringify(plan).slice(0, 200));

// Control: valid delete
r = await runCase({ name: "control:valid-delete", method: "POST", path: R2, headers: acctDeleter.auth, body: JSON.stringify({ confirmationToken: plan.confirmationToken }), timeoutMs: 8000 });
record(R2, { name: "control:valid-delete" }, r, 200);
console.log("control delete:", r.status, r.head.slice(0, 200));

// Replay with same token after deletion (fresh acct for second wave)
const acctD2 = await makeAccount(4, { verified: true });
const plan2 = await (await fetch(base + "/api/account/deletion/plan", { headers: { Cookie: acctD2.auth.Cookie } })).json();

const delEdges = [
  { name: "auth:no-cookie", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ confirmationToken: plan2.confirmationToken }), expect: 401 },
  { name: "auth:garbage-cookie", headers: { "Content-Type": "application/json", Origin: base, Cookie: "account_session=garbage" }, body: JSON.stringify({ confirmationToken: plan2.confirmationToken }), expect: 401 },
  { name: "auth:foreign-origin", headers: { ...acctD2.auth, Origin: "https://evil.example.com" }, body: JSON.stringify({ confirmationToken: plan2.confirmationToken }), expect: 403 },
  { name: "auth:missing-csrf", headers: { "Content-Type": "application/json", Origin: base, Cookie: acctD2.auth.Cookie }, body: JSON.stringify({ confirmationToken: plan2.confirmationToken }), expect: 403 },
];
for (const e of delEdges) {
  const rr = await runCase({ name: e.name, method: "POST", path: R2, headers: e.headers, body: e.body, timeoutMs: 8000 });
  record(R2, { name: e.name }, rr, e.expect);
}

// Token validation edges (authed acctD2)
const tokenEdges = [
  { name: "token:missing-body-keys", body: "{}", expect: 422 },
  { name: "token:empty-object", body: JSON.stringify({ confirmationToken: "" }), expect: 422 },
  { name: "token:number", body: JSON.stringify({ confirmationToken: 123 }), expect: 422 },
  { name: "token:null", body: JSON.stringify({ confirmationToken: null }), expect: 422 },
  { name: "token:array", body: JSON.stringify({ confirmationToken: [] }), expect: 422 },
  { name: "token:object", body: JSON.stringify({ confirmationToken: {} }), expect: 422 },
  { name: "token:garbage-string", body: JSON.stringify({ confirmationToken: "not-a-real-token" }), expect: null }, // expect 4xx
  { name: "token:other-account-token", body: JSON.stringify({ confirmationToken: plan2.confirmationToken.slice(0, -2) + "xx" }), expect: null },
  { name: "token:huge-100k", body: JSON.stringify({ confirmationToken: "t".repeat(100000) }), expect: null },
  { name: "token:proto-pollution", body: '{"confirmationToken":"x","__proto__":{"admin":true}}', expect: null },
];
for (const e of tokenEdges) {
  const rr = await runCase({ name: e.name, method: "POST", path: R2, headers: acctD2.auth, body: e.body, timeoutMs: 8000 });
  if (e.expect === null) {
    if (!(typeof rr.status === "number" && rr.status >= 400 && rr.status < 500)) {
      findings.push({ route: R2, case: e.name, method: "POST", status: rr.status, head: rr.head, note: "expected 4xx for bad token" });
    }
  } else record(R2, { name: e.name }, rr, e.expect);
}

// Now do the real delete for acctD2, then test post-deletion behavior
r = await runCase({ name: "control:valid-delete-2", method: "POST", path: R2, headers: acctD2.auth, body: JSON.stringify({ confirmationToken: plan2.confirmationToken }), timeoutMs: 8000 });
console.log("control delete 2:", r.status);
record(R2, { name: "control:valid-delete-2" }, r, 200);

// Replay same token after account is gone
r = await runCase({ name: "replay:token-after-delete", method: "POST", path: R2, headers: acctD2.auth, body: JSON.stringify({ confirmationToken: plan2.confirmationToken }), timeoutMs: 8000 });
console.log("replay after delete:", r.status, r.head.slice(0, 160));
if (r.status !== 401 && r.status !== 403 && r.status !== 422 && r.status !== 409) {
  findings.push({ route: R2, case: "replay:token-after-delete", method: "POST", status: r.status, head: r.head, note: "expected 401/403/422/409 after account deleted" });
}

// Plan endpoint after deletion
{
  const pr = await fetch(base + "/api/account/deletion/plan", { headers: { Cookie: acctD2.auth.Cookie } });
  console.log("plan-after-delete status:", pr.status);
  if (pr.status === 200) findings.push({ route: R2, case: "plan-after-delete", note: "plan endpoint returns 200 for deleted account" });
}

// ---------- R2: method matrix ----------
for (const c of methodMatrix(R2)) {
  const rr = await runCase({ ...c, headers: acctVerified.auth });
  record(R2, c, rr, 405);
}

// ---------- R2: body fuzz (authed, sacrificial account) ----------
const acctD3 = await makeAccount(5, { verified: true });
const plan3 = await (await fetch(base + "/api/account/deletion/plan", { headers: { Cookie: acctD3.auth.Cookie } })).json();
const goodToken = plan3.confirmationToken;
for (const c of jsonCases(R2, "POST", { Origin: base, Cookie: acctD3.auth.Cookie, "X-CSRF-Token": acctD3.auth["X-CSRF-Token"] })) {
  const rr = await runCase(c);
  record(R2, c, rr, null);
}
// delete acctD3 properly at end
r = await runCase({ name: "control:valid-delete-3", method: "POST", path: R2, headers: acctD3.auth, body: JSON.stringify({ confirmationToken: goodToken }), timeoutMs: 8000 });
record(R2, { name: "control:valid-delete-3" }, r, 200);

// ---------- raw socket abuse against both routes ----------
for (const p of [R1, R2]) {
  const c = { name: "raw:content-length-lie-big", raw: true, payload: `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000000\r\n\r\n{"a":1}`, timeoutMs: 8000 };
  const rr = await runCase(c);
  record(p, c, rr, null);
}

// ---------- crash check ----------
const ok = await healthOk();
if (!ok) { crashes++; findings.push({ route: "*", case: "server-health", note: "server did not survive fuzz run" }); }
console.log("health after run:", ok);

await shutdown();
const out = { worker: 8, shard: ["server/http.mjs:1214 POST /api/auth/email/verify/resend", "server/http.mjs:2398 POST /api/account/delete"], crashes, findings };
await import("node:fs/promises").then(m => m.writeFile(new URL("./findings.json", import.meta.url), JSON.stringify(out, null, 2)));
console.log(`done. findings=${findings.length}`);
