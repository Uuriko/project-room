#!/usr/bin/env node
// WORKER 14 fuzz batch: shard (index mod 50)==13 of server/http.mjs route handlers.
// Targets: GET /api/public/rooms/directory (http.mjs:1722), GET/HEAD /api/needs-me (http.mjs:3130).
import { writeFileSync } from "node:fs";

const BASE = process.env.W14_BASE || "http://127.0.0.1:14414";
const TIMEOUT_MS = 8000;
const results = [];

async function req(method, path, { headers = {}, body = null } = {}) {
  const url = BASE + path;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await res.text();
    results.push({ method, path, status: res.status, ms: Date.now() - start, bodyLen: text.length, bodyHead: text.slice(0, 300), timeout: false });
  } catch (e) {
    results.push({ method, path, status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERR", ms: Date.now() - start, bodyLen: 0, bodyHead: String(e).slice(0, 200), timeout: true });
  } finally {
    clearTimeout(t);
  }
}

const g = (p, h) => req("GET", p, { headers: h });
const h = (p, hd) => req("HEAD", p, { headers: hd });

// ---- mint an identity for needs-me ----
let secret = null;
try {
  const r = await fetch(BASE + "/api/agent-identities", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "w14fuzz" }) });
  const j = await r.json();
  secret = j.secret || j.identitySecret || null;
  results.push({ phase: "mint", status: r.status, secretGot: !!secret });
} catch (e) {
  results.push({ phase: "mint", status: "ERR", err: String(e).slice(0, 200) });
}
const auth = secret ? { authorization: `Bearer ${secret}` } : {};

console.log("secret?", !!secret);

// ---- TARGET 1: /api/public/rooms/directory ----
const D = "/api/public/rooms/directory";
await g(D);
await g(D + "?limit=-1");
await g(D + "?limit=0");
await g(D + "?limit=abc");
await g(D + "?limit=");
await g(D + "?limit=1.5");
await g(D + "?limit=99999999999999999999");
await g(D + "?limit=1e30");
await g(D + "?limit=Infinity");
await g(D + "?limit=NaN");
await g(D + "?limit=0x10");
await g(D + "?limit=%00");
await g(D + "?limit=10&limit=20");
await g(D + "?limit=" + "9".repeat(500));
await g(D + "?after=" + "x".repeat(384));
await g(D + "?after=" + "x".repeat(385));
await g(D + "?after=" + encodeURIComponent("x' OR 1=1 --"));
await g(D + "?after=" + encodeURIComponent("%00"));
await g(D + "?after=" + encodeURIComponent("\u{1F600}".repeat(100)));
await g(D + "?after=" + "a".repeat(100000));
await g(D + "?limit=101");
await g(D + "?unknown=1");
await req("POST", D, { body: "x" });
await req("PUT", D, { body: "x" });
await req("DELETE", D);
await req("HEAD", D);
await req("OPTIONS", D);
await req("PATCH", D);
await g(D + "/");

// ---- TARGET 2: /api/needs-me ----
const N = "/api/needs-me";
await g(N);                                   // no auth -> expect 401
await g(N, { authorization: "Bearer bogus" });
await g(N, { authorization: "Bearer rk_test123" });   // API_KEY_PREFIX guess
await g(N, auth);                             // valid
await h(N, auth);                             // HEAD valid
await req("POST", N, { headers: auth, body: "x" });
await req("DELETE", N, { headers: auth });
if (secret) {
  const S = (v) => `/api/needs-me?since=${encodeURIComponent(v)}`;
  await g(S("-1"), auth);
  await g(S("abc"), auth);
  await g(S("1.5"), auth);
  await g(S(""), auth);
  await g(S("   "), auth);
  await g(S("9007199254740993"), auth);       // > MAX_SAFE_INTEGER
  await g(S("-9007199254740993"), auth);
  await g(S("0x10"), auth);
  await g(S("{invalid"), auth);
  await g(S("[1,2]"), auth);
  await g(S("null"), auth);
  await g(S("true"), auth);
  await g(S('"123"'), auth);
  await g(S('{"rooms":{"r":-1}}'), auth);
  await g(S('{"rooms":{"r":"abc"}}'), auth);
  await g(S('{"rooms":{"r":1.5}}'), auth);
  await g(S(`{"rooms":{"${"k".repeat(129)}":1}}`), auth);
  await g(S('{"rooms":{"r":9007199254740993}}'), auth);
  await g(S('{"rooms":{}}'), auth);
  await g(S('{"land":{"r":1}}'), auth);
  await g(S('{"rooms":{"r":1},"land":{"r":-5}}'), auth);
  await g(S('{"rooms":{"r":1},"landIds":{"r":123}}'), auth);  // landIds value not string
  await g(S(`{"rooms":{"r":1},"roomAfter":"${"z".repeat(129)}"}`), auth);
  await g(S('{"rooms":{"r":1},"floor":-1}'), auth);
  await g(S('{"rooms":{"r":1},"floor":1.5}'), auth);
  await g(S('{"rooms":["x"]}'), auth);
  await g(S('{"rooms":{"r":1}}'.repeat(200)), auth);   // huge param
  await g(S(`{"rooms":{"r":1}}`) , auth);  // valid object form
}

writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 1));
const weird = results.filter(r => r.timeout || (typeof r.status === "number" && (r.status >= 500 || (r.status === 200 && r.ms > 3000))));
console.log("total:", results.length, "| suspicious:", weird.length);
for (const w of weird) console.log("SUSPICIOUS:", w.method, w.path, w.status, w.ms + "ms", (w.bodyHead || "").slice(0, 120));
// status census for directory/no-auth needs-me
for (const r of results.filter(r => r.method && r.path)) {
  console.log(r.status, r.method, r.path.slice(0, 70));
}
