// WORKER 38 (shard 37/50) — WAVE-2000 GUILD-02 API fuzzing.
// Targets (sorted route list in server/http.mjs, index%50==37):
//   POST /api/auth/password/set  (server/http.mjs:2295)
//   GET|HEAD /api/updates        (server/http.mjs:3171)
// Boots a local server on 127.0.0.1 with the acceptance fixture, mints auth
// material on the store, and hammers both handlers with adversarial cases.
// Verdicts: unexpected-500, hang (client timeout), stack-leak, wrong-status
// (deviation from the documented/contracted status), slow (>2000ms).
// Usage: TMPDIR=<worktree>/.tmp node worker-38/fuzz38.mjs
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const OUT = new URL("./results-38.json", import.meta.url);
const findings = [];
let server = null, fixture = null, base = null, crashes = 0;
let passed = 0, ran = 0;

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
async function reboot() {
  await shutdown();
  await boot();
  // re-mint auth material after reboot
  await mintAuth();
}
async function healthOk() {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(base + "/api/health", { signal: c.signal }); clearTimeout(t);
    return r.status === 200;
  } catch { return false; }
}

// ---------- auth material (re-minted after each reboot) ----------
let ACCT = null;      // { cookie, csrf, id, binding }
let IDENT_SECRET = null;
let IDENT_SECRET2 = null;

const token43 = () => randomBytes(32).toString("base64url").slice(0, 43);

async function mintAuth() {
  const store = fixture.store;
  const accountId = store.db.prepare("SELECT id FROM accounts LIMIT 1").get().id;
  const slot = store.createAccountSessionSlot();
  store.loginAccountSession(slot.token, store.issueAccountAccessKey(accountId), slot.session.sessionRevision);
  const fresh = store.accountSessionSlot(slot.token);
  ACCT = { cookie: `account_session=${slot.token}`, csrf: fresh.csrf, id: accountId, binding: fresh.sessionBinding ?? null };

  IDENT_SECRET = "pri_" + token43();
  IDENT_SECRET2 = "pri_" + token43();
  store.identities.create("fuzz38-a", { secret: IDENT_SECRET });
  store.identities.create("fuzz38-b", { secret: IDENT_SECRET2 });
}

// ---------- case runner ----------
const looksLikeStack = h => /at\s+\S+\s*\(|Error:\s|\.mjs:\d+|node:internal/.test(h || "");

async function runCase(c) {
  const started = Date.now();
  let status, text = "";
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), c.timeoutMs ?? 8000);
    const r = await fetch(base + c.path, {
      method: c.method, headers: c.headers || {}, body: c.rawBody ?? undefined,
      signal: ctl.signal, redirect: "manual",
    });
    clearTimeout(timer);
    status = r.status;
    text = (await r.text().catch(() => "")).slice(0, 500);
  } catch (e) {
    status = e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR";
    text = String(e.message).slice(0, 200);
  }
  const ms = Date.now() - started;
  ran++;
  const rec = { batch: c.batch, name: c.name, method: c.method, path: c.path.slice(0, 140), status, ms };
  let verdict = null;
  if (status === 500) verdict = "unexpected-500";
  else if (status === "TIMEOUT") verdict = "hang";
  else if (status === "FETCH-ERROR" && !/GET\/HEAD method cannot have body|Failed to parse URL|Invalid/.test(text)) verdict = "transport-anomaly";
  if (looksLikeStack(text)) { verdict = verdict ?? "stack-leak"; rec.leak = "possible-stack-leak"; }
  if (c.expect !== undefined && typeof status === "number" && status !== c.expect) {
    verdict = "wrong-status";
    rec.expected = c.expect;
  }
  if (!verdict && ms > 2000 && status !== "TIMEOUT") { verdict = "slow"; }
  if (verdict) { rec.verdict = verdict; rec.head = text.slice(0, 220); findings.push(rec); console.log(`  [${verdict}] ${c.batch}/${c.name}: got ${status}${c.expect !== undefined ? ` want ${c.expect}` : ""} (${ms}ms)`); }
  else { passed++; if (c.expect === undefined) console.log(`  [exploratory] ${c.batch}/${c.name}: ${status} (${ms}ms) :: ${(text || "").slice(0, 120)}`); }
  return rec;
}

const J = o => JSON.stringify(o);
const originHeaders = (extra = {}) => ({ Origin: base, ...extra });

// ================= BATCH 1: password/set surface (no auth) =================
async function batch1() {
  const P = "/api/auth/password/set";
  const cases = [
    { name: "get", method: "GET", path: P, headers: {}, expect: 405 },
    { name: "head", method: "HEAD", path: P, headers: {}, expect: 405 },
    { name: "put", method: "PUT", path: P, headers: {}, expect: 405 },
    { name: "patch", method: "PATCH", path: P, headers: {}, expect: 405 },
    { name: "delete", method: "DELETE", path: P, headers: {}, expect: 405 },
    { name: "options", method: "OPTIONS", path: P, headers: {}, expect: 405 },
    { name: "post-no-origin", method: "POST", path: P, headers: { "Content-Type": "application/json" }, rawBody: J({ password: "x".repeat(20) }), expect: 403 },
    { name: "post-wrong-origin", method: "POST", path: P, headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, rawBody: J({ password: "x".repeat(20) }), expect: 403 },
    { name: "post-no-content-type", method: "POST", path: P, headers: { Origin: base }, expect: 401 }, // session check comes after origin; no session -> 401 (415 only after auth)
    { name: "post-origin-no-session", method: "POST", path: P, headers: { Origin: base, "Content-Type": "application/json" }, rawBody: J({ password: "x".repeat(20) }), expect: 401 },
    { name: "post-bad-cookie", method: "POST", path: P, headers: { Origin: base, "Content-Type": "application/json", Cookie: "account_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, rawBody: J({ password: "x".repeat(20) }), expect: 401 },
    { name: "post-garbage-cookie", method: "POST", path: P, headers: { Origin: base, "Content-Type": "application/json", Cookie: "account_session=!!!not-a-token!!!" }, rawBody: J({ password: "x".repeat(20) }), expect: 401 },
    { name: "post-query-noise", method: "POST", path: P + "?foo=bar&password=hunter2", headers: { Origin: base, "Content-Type": "application/json" }, rawBody: J({ password: "x".repeat(20) }), expect: 401 },
    { name: "post-trailing-slash", method: "POST", path: P + "/", headers: { Origin: base, "Content-Type": "application/json" }, rawBody: J({ password: "x".repeat(20) }), expect: 401 }, // trailing slash normalized up front (http.mjs:948); no cookie -> 401
    { name: "post-uppercase-path", method: "POST", path: "/api/auth/PASSWORD/set", headers: { Origin: base, "Content-Type": "application/json" }, rawBody: J({ password: "x".repeat(20) }), expect: 404 },
  ];
  for (const c of cases) await runCase({ batch: "pw-surface", timeoutMs: 8000, ...c });
}

// ================= BATCH 2: password/set authenticated body fuzz (part 1) =================
async function batch2() {
  const P = "/api/auth/password/set";
  const auth = h => ({ Origin: base, "Content-Type": "application/json", Cookie: ACCT.cookie, "X-CSRF-Token": ACCT.csrf, ...h });
  const bodies = [
    ["empty-object", J({}), 422],
    ["password-number", J({ password: 123 }), 422],
    ["password-null", J({ password: null }), 422],
    ["password-bool", J({ password: true }), 422],
    ["password-array", J({ password: ["x".repeat(20)] }), 422],
    ["password-object", J({ password: { v: "x".repeat(20) } }), 422],
    ["password-empty-string", J({ password: "" }), 422],
    ["password-too-short", J({ password: "short1" }), 422],
    ["password-extra-keys", J({ password: "x".repeat(20), admin: true }), 422],
    ["password-missing-key", J({ passw0rd: "x".repeat(20) }), 422],
    ["password-dup-keys", '{"password":"short","password":"' + "x".repeat(20) + '"}', undefined],
    ["password-unicode", J({ password: "\U0001F511".repeat(10) }), undefined],
    ["json-array-top", J(["x".repeat(20)]), 400],
    ["json-string-top", J("x".repeat(20)), 400],
  ];
  for (const [name, bodyStr, expect] of bodies) {
    await runCase({ batch: "pw-body", name, method: "POST", path: P, headers: auth(), rawBody: bodyStr, expect, timeoutMs: 8000 });
  }
}

// ================= BATCH 2b: password/set body fuzz (part 2) =================
async function batch2b() {
  const P = "/api/auth/password/set";
  const auth = h => ({ Origin: base, "Content-Type": "application/json", Cookie: ACCT.cookie, "X-CSRF-Token": ACCT.csrf, ...h });
  const rawAuth = h => ({ Origin: base, Cookie: ACCT.cookie, "X-CSRF-Token": ACCT.csrf, ...h });
  const bodies = [
    ["json-number-top", J(42), 400],
    ["json-null-top", J(null), 400],
    ["json-true-top", J(true), 400],
    ["json-empty", "", 400],
    ["json-whitespace", "   \n\t ", 400],
    ["json-malformed", '{"password":', 400],
    ["json-trailing-garbage", J({ password: "x".repeat(20) }) + "!!!", 400],
    ["json-deep-nest", J({ password: { a: { b: { c: "x".repeat(20) } } } }), 422],
    ["json-huge-keys", J({ ["k".repeat(8000)]: "x".repeat(20) }), 422],
    ["json-huge-array-top", J(new Array(1000).fill("x")), 400],
    ["password-256-boundary", J({ password: "x".repeat(256) }), undefined], // at policy max: proceeds past policy
    ["password-257-too-long", J({ password: "x".repeat(257) }), 422],
    ["password-9-too-short", J({ password: "x".repeat(9) }), 422],
    ["password-10-min", J({ password: "x".repeat(10) }), undefined], // at policy min: proceeds past policy
  ];
  for (const [name, bodyStr, expect] of bodies) {
    await runCase({ batch: "pw-body", name, method: "POST", path: P, headers: auth(), rawBody: bodyStr, expect, timeoutMs: 8000 });
  }
  const variants = [
    { name: "no-content-type", headers: rawAuth(), rawBody: J({ password: "x".repeat(20) }), expect: 415 },
    { name: "text-plain", headers: rawAuth({ "Content-Type": "text/plain" }), rawBody: J({ password: "x".repeat(20) }), expect: 415 },
  ];
  for (const v of variants) await runCase({ batch: "pw-body", method: "POST", path: P, timeoutMs: 8000, ...v });
}

// ================= BATCH 2c: password/set header/csrf/transport variants =================
async function batch2c() {
  const P = "/api/auth/password/set";
  const auth = h => ({ Origin: base, "Content-Type": "application/json", Cookie: ACCT.cookie, "X-CSRF-Token": ACCT.csrf, ...h });
  const rawAuth = h => ({ Origin: base, Cookie: ACCT.cookie, "X-CSRF-Token": ACCT.csrf, ...h });
  const variants = [
    { name: "charset-suffix", headers: rawAuth({ "Content-Type": "application/json; charset=utf-8" }), rawBody: J({ password: "x".repeat(20) }), expect: undefined },
    { name: "uppercase-content-type", headers: rawAuth({ "Content-Type": "Application/JSON" }), rawBody: J({ password: "x".repeat(20) }), expect: undefined },
    { name: "no-csrf", headers: { Origin: base, "Content-Type": "application/json", Cookie: ACCT.cookie }, rawBody: J({ password: "x".repeat(20) }), expect: 403 },
    { name: "wrong-csrf", headers: auth({ "X-CSRF-Token": "0".repeat(64) }), rawBody: J({ password: "x".repeat(20) }), expect: 403 },
    { name: "short-csrf", headers: auth({ "X-CSRF-Token": "abc" }), rawBody: J({ password: "x".repeat(20) }), expect: 403 },
    { name: "oversize-body", headers: auth(), rawBody: J({ password: "x".repeat(20000) }), expect: 413 },
    { name: "invalid-utf8", headers: auth(), rawBody: Buffer.from([0x7b,0x22,0x70,0x61,0x73,0x73,0x77,0x6f,0x72,0x64,0x22,0x3a,0x22,0xff,0xfe,0x22,0x7d]), expect: 422 }, // {"password":"<0xFF><0xFE>"} real invalid bytes -> U+FFFD replacements -> too short
    { name: "null-bytes-body", headers: auth(), rawBody: Buffer.from('{"password":"a\x00b"}'), expect: undefined },
  ];
  for (const v of variants) await runCase({ batch: "pw-body", method: "POST", path: P, timeoutMs: 8000, ...v });
}
// ================= BATCH 3: password/set success + 409 replay =================
async function batch3() {
  const P = "/api/auth/password/set";
  const store = fixture.store;
  // fresh account with a verified email method but NO password method
  const accountId = "acct-fuzz38-" + token43().slice(0, 8);
  store.createAccount(accountId, "fuzz38");
  store.accountLogins.linkMagicMethod(accountId, { email: "fuzz38@example.invalid" });
  const slot = store.createAccountSessionSlot();
  store.loginAccountSession(slot.token, store.issueAccountAccessKey(accountId), slot.session.sessionRevision);
  const fresh = store.accountSessionSlot(slot.token);
  const headers = { Origin: base, "Content-Type": "application/json", Cookie: `account_session=${slot.token}`, "X-CSRF-Token": fresh.csrf };
  const good = "fuzz38-valid-password-1";
  const r1 = await runCase({ batch: "pw-success", name: "first-set-201", method: "POST", path: P, headers, rawBody: J({ password: good }), expect: 201, timeoutMs: 15000 });
  console.log(`  first-set body: ${(r1.head || "").slice(0, 160)}`);
  await runCase({ batch: "pw-success", name: "replay-409", method: "POST", path: P, headers, rawBody: J({ password: "another-valid-password-2" }), expect: 409, timeoutMs: 15000 });
  // weak-password policy on a fresh account
  const accountId2 = "acct-fuzz38-" + token43().slice(0, 8);
  store.createAccount(accountId2, "fuzz38");
  store.accountLogins.linkMagicMethod(accountId2, { email: "fuzz38b@example.invalid" });
  const slot2 = store.createAccountSessionSlot();
  store.loginAccountSession(slot2.token, store.issueAccountAccessKey(accountId2), slot2.session.sessionRevision);
  const fresh2 = store.accountSessionSlot(slot2.token);
  const h2 = { Origin: base, "Content-Type": "application/json", Cookie: `account_session=${slot2.token}`, "X-CSRF-Token": fresh2.csrf };
  await runCase({ batch: "pw-success", name: "weak-422", method: "POST", path: P, headers: h2, rawBody: J({ password: "tiny" }), expect: 422, timeoutMs: 15000 });
  await runCase({ batch: "pw-success", name: "valid-after-weak-201", method: "POST", path: P, headers: h2, rawBody: J({ password: good + "x" }), expect: 201, timeoutMs: 15000 });
}

// ================= BATCH 4: updates surface =================
async function batch4() {
  const P = "/api/updates";
  const cases = [
    { name: "post", method: "POST", path: P, headers: {}, expect: 405 },
    { name: "put", method: "PUT", path: P, headers: {}, expect: 405 },
    { name: "patch", method: "PATCH", path: P, headers: {}, expect: 405 },
    { name: "delete", method: "DELETE", path: P, headers: {}, expect: 405 },
    { name: "get-no-auth", method: "GET", path: P, headers: {}, expect: 401 },
    { name: "head-no-auth", method: "HEAD", path: P, headers: {}, expect: 401 },
    { name: "bad-scheme", method: "GET", path: P, headers: { Authorization: "Basic abcdef" }, expect: 401 },
    { name: "bearer-no-token", method: "GET", path: P, headers: { Authorization: "Bearer" }, expect: 401 },
    { name: "bearer-bad-shape", method: "GET", path: P, headers: { Authorization: "Bearer garbage" }, expect: 401 },
    { name: "bearer-short", method: "GET", path: P, headers: { Authorization: "Bearer abc" }, expect: 401 },
    { name: "bearer-trailing-slash", method: "GET", path: P + "/", headers: {}, expect: 401 }, // trailing slash normalized up front (http.mjs:948); no auth -> 401
    { name: "get-query-no-auth", method: "GET", path: P + "?limit=abc", headers: {}, expect: 401 }, // auth before query parse
  ];
  for (const c of cases) await runCase({ batch: "up-surface", timeoutMs: 8000, ...c });
}

// ================= BATCH 5: updates bearer deep path =================
async function batch5() {
  const P = "/api/updates";
  const auth = { Authorization: `Bearer ${IDENT_SECRET}` };
  const cases = [
    { name: "bearer-unknown-43", headers: { Authorization: `Bearer ${token43()}` }, expect: 401 },
    { name: "bearer-unknown-pri", headers: { Authorization: `Bearer pri_${token43()}` }, expect: 401 },
    { name: "bearer-lowercase-scheme", headers: { Authorization: `bearer ${IDENT_SECRET}` }, expect: 200 },
    { name: "bearer-upper-scheme", headers: { Authorization: `BEARER ${IDENT_SECRET}` }, expect: 200 },
    { name: "bearer-ok", headers: auth, expect: 200 },
    { name: "head-ok", method: "HEAD", headers: auth, expect: 200 },
    { name: "limit-abc", path: P + "?limit=abc", headers: auth, expect: 422 },
    { name: "limit-0", path: P + "?limit=0", headers: auth, expect: 422 },
    { name: "limit-neg", path: P + "?limit=-5", headers: auth, expect: 422 },
    { name: "limit-101", path: P + "?limit=101", headers: auth, expect: 422 },
    { name: "limit-100", path: P + "?limit=100", headers: auth, expect: 200 },
    { name: "limit-1", path: P + "?limit=1", headers: auth, expect: 200 },
    { name: "limit-1e2", path: P + "?limit=1e2", headers: auth, expect: 200 },
    { name: "limit-hex", path: P + "?limit=0x10", headers: auth, expect: 200 },
    { name: "limit-frac", path: P + "?limit=1.5", headers: auth, expect: 422 },
    { name: "limit-empty", path: P + "?limit=", headers: auth, expect: 422 },
    { name: "limit-infinity", path: P + "?limit=Infinity", headers: auth, expect: 422 },
    { name: "limit-huge", path: P + "?limit=99999999999999999999", headers: auth, expect: 422 },
    { name: "limit-spaces", path: P + "?limit=%2050%20", headers: auth, expect: 200 },
    { name: "limit-plus", path: P + "?limit=+50", headers: auth, expect: 200 },
    { name: "limit-dup", path: P + "?limit=10&limit=10", headers: auth, expect: 422 },
    { name: "state-bogus", path: P + "?state=bogus", headers: auth, expect: 422 },
    { name: "state-empty", path: P + "?state=", headers: auth, expect: 422 },
    { name: "state-all", path: P + "?state=all", headers: auth, expect: 200 },
    { name: "state-case", path: P + "?state=ALL", headers: auth, expect: 422 },
    { name: "kinds-ok", path: P + "?kinds=request,mention", headers: auth, expect: 200 },
    { name: "kinds-bogus", path: P + "?kinds=bogus", headers: auth, expect: 422 },
    { name: "kinds-empty", path: P + "?kinds=", headers: auth, expect: 200 },
    { name: "kinds-commas", path: P + "?kinds=request,,mention,", headers: auth, expect: 200 },
    { name: "kinds-case", path: P + "?kinds=REQUEST", headers: auth, expect: 422 },
    { name: "kinds-huge", path: P + "?kinds=" + "request,".repeat(500), headers: auth, expect: 200 },
    { name: "cursor-garbage", path: P + "?cursor=!!!not-base64!!!", headers: auth, expect: 422 },
    { name: "cursor-empty", path: P + "?cursor=", headers: auth, expect: 200 },
    { name: "cursor-wrong-viewer", path: P + "?cursor=" + Buffer.from(J({ v: 1, viewer: "identity:other", updatedAt: "x", id: "y" })).toString("base64url"), headers: auth, expect: 422 },
    { name: "cursor-wrong-v", path: P + "?cursor=" + Buffer.from(J({ v: 2, viewer: "x", updatedAt: "x", id: "y" })).toString("base64url"), headers: auth, expect: 422 },
    { name: "unknown-param", path: P + "?foo=bar", headers: auth, expect: 422 },
    { name: "auth-param-allowed", path: P + "?auth=x", headers: auth, expect: 200 },
    { name: "combo", path: P + "?state=all&kinds=request&limit=5", headers: auth, expect: 200 },
    { name: "huge-query", path: P + "?state=all&" + "z".repeat(8000) + "=1", headers: auth, expect: 422 },
  ];
  for (const c of cases) await runCase({ batch: "up-bearer", method: c.method || "GET", path: c.path || P, timeoutMs: 8000, ...c });
}

// ================= BATCH 6: updates account-cookie deep path =================
async function batch6() {
  const P = "/api/updates";
  const noBinding = { Cookie: ACCT.cookie };
  await runCase({ batch: "up-cookie", name: "cookie-no-binding", method: "GET", path: P, headers: noBinding, expect: 422, timeoutMs: 8000 });
  await runCase({ batch: "up-cookie", name: "cookie-bad-binding-header", method: "GET", path: P, headers: { ...noBinding, "X-Session-Binding": "zzz" }, expect: 422, timeoutMs: 8000 });
  await runCase({ batch: "up-cookie", name: "cookie-binding-query-bad", method: "GET", path: P + "?binding=zzz", headers: noBinding, expect: 422, timeoutMs: 8000 });
  await runCase({ batch: "up-cookie", name: "cookie-binding-query-dup", method: "GET", path: P + "?binding=a&binding=b", headers: noBinding, expect: 422, timeoutMs: 8000 });
  if (ACCT.binding) {
    const good = { Cookie: ACCT.cookie, "X-Session-Binding": ACCT.binding };
    const r = await runCase({ batch: "up-cookie", name: "cookie-binding-ok", method: "GET", path: P, headers: good, expect: 200, timeoutMs: 8000 });
    console.log(`  cookie-ok body: ${(r.head || "").slice(0, 160)}`);
    await runCase({ batch: "up-cookie", name: "cookie-binding-ok-limit", method: "GET", path: P + "?limit=3&state=all", headers: good, expect: 200, timeoutMs: 8000 });
    await runCase({ batch: "up-cookie", name: "cookie-head-ok", method: "HEAD", path: P, headers: good, expect: 200, timeoutMs: 8000 });
  } else {
    console.log("  NOTE: no sessionBinding on fixture slot; good-binding cases skipped");
  }
  // mismatched binding (valid 64-hex but wrong)
  await runCase({ batch: "up-cookie", name: "cookie-binding-wrong", method: "GET", path: P, headers: { ...noBinding, "X-Session-Binding": "a".repeat(64) }, expect: undefined, timeoutMs: 8000 });
}

// ================= BATCH 7: rate-limit behavior (expected 429s, never 500/hang) =================
async function batch7() {
  // 25 rapid authed POSTs to password/set -> first ~20 fine-ish, then 429. None may 500/hang.
  const headers = { Origin: base, "Content-Type": "application/json", Cookie: ACCT.cookie, "X-CSRF-Token": ACCT.csrf };
  let saw429 = false, saw500 = false;
  for (let i = 0; i < 25; i++) {
    const r = await runCase({ batch: "rate", name: `pw-burst-${i}`, method: "POST", path: "/api/auth/password/set", headers, rawBody: J({}), timeoutMs: 8000 });
    if (r.status === 429) saw429 = true;
    if (r.status === 500) saw500 = true;
  }
  console.log(`  burst: saw429=${saw429} saw500=${saw500}`);
  if (!saw429) findings.push({ batch: "rate", name: "pw-burst-no-429", verdict: "wrong-status", note: "expected 429 after ~20 rapid posts, never saw one" });
}

const batches = [
  ["pw-surface", batch1], ["pw-body", batch2], ["pw-body2", batch2b], ["pw-body3", batch2c], ["pw-success", batch3],
  ["up-surface", batch4], ["up-bearer", batch5], ["up-cookie", batch6], ["rate", batch7],
];

await boot();
console.log(`booted ${base}`);
await mintAuth();
console.log(`auth minted: account=${ACCT.id} binding=${ACCT.binding ? "yes" : "no"}`);

for (const [name, fn] of batches) {
  console.log(`--- batch ${name} ---`);
  await fn();
  if (!(await healthOk())) {
    crashes++;
    findings.push({ batch: name, name: "*", verdict: "crash", note: "server dead after batch — restarted" });
    console.log("  CRASH — restarting");
  }
  await reboot();
  console.log("  rebooted (rate state reset)");
}
await shutdown();

const summary = { worker: 38, shard: "37/50", ran, passed, crashes, findingCount: findings.length, findings };
writeFileSync(OUT, JSON.stringify(summary, null, 1));
console.log(`done: ${ran} cases, ${passed} passed, ${findings.length} findings, ${crashes} crashes -> ${OUT}`);
