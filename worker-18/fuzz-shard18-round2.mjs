// WORKER-18 round-2 fuzz: edge semantics on the two shard handlers.
import { setTimeout as sleep } from "node:timers/promises";
const BASE = "http://127.0.0.1:41871";
const ORIGIN = BASE;
const J = { Origin: ORIGIN, "Content-Type": "application/json" };
let pass = 0, fail = 0;
const bad = [];
async function probe(name, opts, expect) {
  const { method = "GET", path, headers = {}, body } = opts;
  const t0 = Date.now();
  let res, text = "", err = null;
  try { res = await fetch(BASE + path, { method, headers, body, redirect: "manual" }); text = await res.text(); }
  catch (e) { err = e; }
  const ms = Date.now() - t0;
  const ok = expect({ status: res?.status, text, err, headers: res?.headers });
  if (ok) pass++; else { fail++; bad.push({ name, got: err ? "ERR" : res.status, ms, body: text.slice(0, 120) }); }
  if (ms > 10000) console.log("SLOW:", name, ms + "ms");
  return { res, text };
}

// trailing slash canonicalization (documented QA fix 2026-10-03 P2-1)
await probe("ready trailing slash -> same handler", { path: "/api/ready/" }, ({ status }) => status === 503);
await probe("ready HEAD no body", { method: "HEAD", path: "/api/ready" }, ({ status, text, headers }) => status === 503 && text === "");
// origin edge cases on preview
await probe("preview Origin null", { method: "POST", path: "/api/share-links/preview", headers: { ...J, Origin: "null" }, body: "{}" }, ({ status }) => status === 403);
await probe("preview Origin trailing slash", { method: "POST", path: "/api/share-links/preview", headers: { ...J, Origin: ORIGIN + "/" }, body: "{}" }, ({ status }) => status === 403);
await probe("preview Origin case variant", { method: "POST", path: "/api/share-links/preview", headers: { ...J, Origin: "http://127.0.0.1:41871 " }, body: "{}" }, ({ status }) => status === 403);
// duplicate session cookie -> 401 ambiguous (cookie() path in handler)
await probe("preview dup account cookie", { method: "POST", path: "/api/share-links/preview", headers: { ...J, Cookie: "prs=aaa; prs=bbb" }, body: '{"linkToken":"x"}' }, ({ status }) => status === 401);
// invalid session binding header -> 422
await probe("preview bad x-session-binding", { method: "POST", path: "/api/share-links/preview", headers: { ...J, "X-Session-Binding": "not!!valid" }, body: '{"linkToken":"x"}' }, ({ status }) => status === 422);
// empty body with json content-type
await probe("preview empty body", { method: "POST", path: "/api/share-links/preview", headers: J, body: "" }, ({ status }) => status === 400);
// whitespace body
await probe("preview whitespace body", { method: "POST", path: "/api/share-links/preview", headers: J, body: "   " }, ({ status }) => status === 400);
// Bearer <redacted> format edge: "Bearer " empty token passes carriesBearer
await probe("preview empty Bearer <redacted>", { method: "POST", path: "/api/share-links/preview", headers: { Authorization: "Bearer ", "Content-Type": "application/json" }, body: "{}" }, ({ status }) => status === 422);
// percent-encoded token
await probe("preview pct-encoded token", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":"%2e%2e%2f"}' }, ({ status }) => status === 410);
// unicode token
await probe("preview unicode token", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":"ééé"}' }, ({ status }) => status === 410);
// token with newline
await probe("preview token newline", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"linkToken":"abc\\ndef"}' }, ({ status }) => status === 410);
// __proto__ key in body
await probe("preview __proto__ body", { method: "POST", path: "/api/share-links/preview", headers: J, body: '{"__proto__":{"x":1}}' }, ({ status }) => status === 422);

console.log("--- rate-limit burn: expect 429 eventually ---");
let saw429 = false, lastStatus = 0;
for (let i = 0; i < 40; i++) {
  const { res } = await probe(`burn ${i}`, { method: "POST", path: "/api/share-links/preview", headers: J, body: "{}" }, () => true);
  lastStatus = res?.status;
  if (lastStatus === 429) { saw429 = true; break; }
}
console.log("rate-limit 429 observed:", saw429, "last status:", lastStatus);

console.log(`\npass=${pass} fail=${fail}`);
for (const b of bad) console.log("FAIL:", b.name, "got", b.got, b.ms + "ms", b.body);
