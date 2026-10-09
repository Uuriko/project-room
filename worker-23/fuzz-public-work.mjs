// WAVE-2000 GUILD-02 WORKER 23 — extended fuzz battery for shard handler
// server/http.mjs:1747  if (url.pathname === "/api/public-work/tasks" || publicWorkTaskMatch || publicWorkReceiptMatch)
// plus the adjacent sibling handler at :1739 (publicWorkReviewMatch) — no worker
// owns it under the grep partition, so worker 23 covers it here and flags
// findings as belonging to the review endpoint.
// Usage: TMPDIR=$PWD/.tmp node worker-23/fuzz-public-work.mjs
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { writeFileSync } from "node:fs";

const fixture = await createAcceptanceFixture();
const server = createRoomServer({ store: fixture.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const KEYS = fixture.keys; // owner/guest/producer/reviewer — synthetic fixture creds, local only

const id64 = "a".repeat(64);
const id128 = "b".repeat(128);
const J = { "Content-Type": "application/json" };

async function send(c) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), c.timeoutMs ?? 8000);
  try {
    const r = await fetch(base + c.path, { method: c.method, headers: c.headers ?? {}, body: c.body ?? undefined, signal: ctl.signal, redirect: "manual" });
    clearTimeout(timer);
    const text = await r.text().catch(() => "");
    return { status: r.status, head: text.slice(0, 300), ms: Date.now() - started };
  } catch (e) {
    clearTimeout(timer);
    return { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR", head: String(e.message).slice(0, 200), ms: Date.now() - started };
  }
}

const looksLikeStack = (h) => /at\s+\S+\s*\(|Error:\s|\.mjs:\d+|node:internal/.test(h || "");

// expect: array of acceptable statuses, or "4xx"/"2xx" class shorthand, or null (any)
const C = [];
const add = (name, method, path, opts = {}) => C.push({ name, method, path, expect: opts.expect ?? null, headers: opts.headers, body: opts.body, timeoutMs: opts.timeoutMs });

// ---- query-param validation on the list endpoint ----
add("q:limit=abc", "GET", "/api/public-work/tasks?limit=abc", { expect: "4xx" });
add("q:limit=0", "GET", "/api/public-work/tasks?limit=0", { expect: "4xx" });
add("q:limit=-1", "GET", "/api/public-work/tasks?limit=-1", { expect: "4xx" });
add("q:limit=101", "GET", "/api/public-work/tasks?limit=101", { expect: "4xx" });
add("q:limit=100", "GET", "/api/public-work/tasks?limit=100", { expect: [200] });
add("q:limit=1.5", "GET", "/api/public-work/tasks?limit=1.5", { expect: "4xx" });
add("q:limit=empty", "GET", "/api/public-work/tasks?limit=", { expect: "4xx" });
add("q:limit=hex", "GET", "/api/public-work/tasks?limit=0x10", { expect: [200] }); // Number("0x10")=16
add("q:limit=huge", "GET", "/api/public-work/tasks?limit=99999999999999999999", { expect: "4xx" });
add("q:limit=dup", "GET", "/api/public-work/tasks?limit=1&limit=2", { expect: [422] });
add("q:limit=case", "GET", "/api/public-work/tasks?Limit=1", { expect: [422] });
add("q:unknown", "GET", "/api/public-work/tasks?foo=1", { expect: [422] });
add("q:after-empty", "GET", "/api/public-work/tasks?after=", { expect: [200] });
add("q:after-nullbyte", "GET", "/api/public-work/tasks?after=%00", { expect: "4xx" });
add("q:after-dotdot", "GET", "/api/public-work/tasks?after=..%2f..%2fetc", { expect: "4xx" });
add("q:after-long", "GET", "/api/public-work/tasks?after=" + "z".repeat(500), { expect: "4xx" });
add("q:after+limit", "GET", "/api/public-work/tasks?limit=5&after=abc", { expect: [200] }); // abc is a valid identifier cursor

// ---- method handling ----
add("m:post-tasks", "POST", "/api/public-work/tasks", { headers: J, body: "{}", expect: [405] });
add("m:put-tasks", "PUT", "/api/public-work/tasks", { expect: [405] });
add("m:delete-tasks", "DELETE", "/api/public-work/tasks", { expect: [405] });
add("m:head-tasks", "HEAD", "/api/public-work/tasks", { expect: [200] });
add("m:post-task-noid-body", "POST", `/api/public-work/tasks/${id64}`, { headers: J, body: "{}", expect: [405] });
add("m:get-claim-action", "GET", `/api/public-work/tasks/${id64}/claim`, { expect: [405] });
add("m:put-claim-action", "PUT", `/api/public-work/tasks/${id64}/claim`, { headers: J, body: "{}", expect: [405] });

// ---- task id path edges ----
add("p:task-64-missing", "GET", `/api/public-work/tasks/${id64}`, { expect: [404] });
add("p:task-trailing-slash", "GET", `/api/public-work/tasks/${id64}/`, { expect: [404] });
add("p:task-double-slash", "GET", `/api/public-work/tasks//claim`, { expect: [404] });
add("p:task-encoded-dotdot", "GET", "/api/public-work/tasks/%2e%2e", { expect: [404] });
add("p:task-uppercase-action", "POST", `/api/public-work/tasks/${id64}/CLAIM`, { headers: J, body: "{}", expect: [404] });
add("p:task-bad-action", "POST", `/api/public-work/tasks/${id64}/delete`, { headers: J, body: "{}", expect: [404] });
add("p:task-action-extra-seg", "POST", `/api/public-work/tasks/${id64}/claim/extra`, { headers: J, body: "{}", expect: [404] });
add("p:task-id-special", "GET", `/api/public-work/tasks/a!b@c`, { expect: [404] });

// ---- action auth: pre-body gates (no valid identity secret available locally) ----
const garbage43 = "q".repeat(43);
add("a:claim-noauth", "POST", `/api/public-work/tasks/${id64}/claim`, { headers: J, body: "{}", expect: [401] });
add("a:claim-empty-bearer", "POST", `/api/public-work/tasks/${id64}/claim`, { headers: { ...J, Authorization: "Bearer " }, body: "{}", expect: [401] });
add("a:claim-bare-bearer", "POST", `/api/public-work/tasks/${id64}/claim`, { headers: { ...J, Authorization: "Bearer" }, body: "{}", expect: [401] });
add("a:claim-garbage-bearer", "POST", `/api/public-work/tasks/${id64}/claim`, { headers: { ...J, Authorization: `Bearer ${garbage43}` }, body: "{}", expect: [401] });
add("a:claim-roomkey-as-identity", "POST", `/api/public-work/tasks/${id64}/claim`, { headers: { ...J, Authorization: `Bearer ${KEYS.owner}` }, body: "{}", expect: [401] });
add("a:claim-query-before-auth", "POST", `/api/public-work/tasks/${id64}/claim?x=1`, { headers: J, body: "{}", expect: [422] });
add("a:finish-garbage-hugebody", "POST", `/api/public-work/tasks/${id64}/finish`, { headers: J, Authorization: `Bearer ${garbage43}`, body: JSON.stringify({ x: "y".repeat(600 * 1024) }), expect: [401], timeoutMs: 15000 });
add("a:claim-invalid-json", "POST", `/api/public-work/tasks/${id64}/claim`, { headers: J, body: '{"a":', expect: [401] }); // auth gate fires before body parse
add("a:renew-noauth", "POST", `/api/public-work/tasks/${id64}/renew`, { headers: J, body: "{}", expect: [401] });
add("a:release-noauth", "POST", `/api/public-work/tasks/${id64}/release`, { headers: J, body: "{}", expect: [401] });

// ---- receipts ----
add("r:receipt-64-missing", "GET", `/api/public-work/receipts/${id64}`, { expect: [404] });
add("r:artifact-64-missing", "GET", `/api/public-work/receipts/${id64}/artifact`, { expect: [404] });
add("r:artifact-head-missing", "HEAD", `/api/public-work/receipts/${id64}/artifact`, { expect: [404] });
add("r:post-receipt", "POST", `/api/public-work/receipts/${id64}`, { headers: J, body: "{}", expect: [405] });
add("r:artifact-trailing", "GET", `/api/public-work/receipts/${id64}/artifact/`, { expect: [404] });
add("r:receipt-query", "GET", `/api/public-work/receipts/${id64}?x=1`, { expect: [422] });

// ---- sibling review endpoint (line 1739; unowned by partition) ----
add("v:review-128-missing", "GET", `/api/public-work/receipts/${id128}/review`, { expect: null });
add("v:review-query", "GET", `/api/public-work/receipts/${id128}/review?x=1`, { expect: [422] });
add("v:review-post", "POST", `/api/public-work/receipts/${id128}/review`, { headers: J, body: "{}", expect: [405] });
add("v:review-put", "PUT", `/api/public-work/receipts/${id128}/review`, { expect: [405] });
add("v:review-shortid", "GET", "/api/public-work/receipts/abc/review", { expect: null });

const findings = [];
for (const c of C) {
  const r = await send(c);
  let verdict = null;
  if (r.status === 500) verdict = "unexpected-500";
  else if (r.status === "TIMEOUT") verdict = "hang";
  else if (r.status === "FETCH-ERROR") verdict = "transport-anomaly";
  else if (looksLikeStack(r.head)) verdict = "possible-stack-leak";
  if (!verdict && c.expect) {
    const ok = c.expect === "4xx" ? (typeof r.status === "number" && r.status >= 400 && r.status < 500)
      : c.expect === "2xx" ? (r.status === 200 || r.status === 204)
      : c.expect.includes(r.status);
    if (!ok) verdict = `wrong-status (expected ${JSON.stringify(c.expect)}, got ${r.status})`;
  }
  const rec = { case: c.name, method: c.method, path: c.path.slice(0, 120), status: r.status, ms: r.ms, head: r.head.slice(0, 160), expect: c.expect, verdict };
  if (verdict) { findings.push(rec); console.log(`FINDING ${c.name}: ${verdict} — ${r.status} ${(r.head || "").slice(0, 100)}`); }
  else console.log(`ok ${c.name}: ${r.status} (${r.ms}ms)`);
}

try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
try { fixture.store.close(); } catch {}
writeFileSync(new URL("./findings-public-work.json", import.meta.url), JSON.stringify({ cases: C.length, findings }, null, 1));
console.log(`done: ${findings.length}/${C.length} anomalous -> worker-23/findings-public-work.json`);
